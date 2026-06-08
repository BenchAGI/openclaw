/**
 * F1 — Tier-1 retrieval-at-start.
 *
 * At the cold start of a fresh thread/session, search the agent's own unified
 * memory index for the session's opening topic and return a small synthetic
 * bootstrap context file ("RETRIEVED-CONTEXT-TIER1.md") to prepend ahead of
 * MEMORY.md. This is a mandatory bootstrap step, not a tool the seat may forget
 * to call — so a fresh thread about a prior topic starts already knowing the
 * relevant prior decision/draft instead of cold.
 *
 * Invariants:
 *  - FAIL-OPEN: any error/timeout/unavailability returns `injected: false`; the
 *    session proceeds with Tier-0 only. This module never throws.
 *  - BOUNDED: top-K hits, byte-capped body — it cannot push Tier-0 out of context.
 *  - TENANT-SAFE: the search is keyed to the caller's own `agentId` (the host
 *    manager derives the per-agent store from it); never pass another agent's id.
 *  - FLAG-GATED: `agents.*.memorySearch.query.tier1.enabled` (default OFF).
 */
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import { getActiveMemorySearchManager } from "../plugin-sdk/memory-host-search.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import { resolveMemorySearchConfig } from "./memory-search.js";

/** Synthetic file name; prepended ahead of MEMORY.md in the bootstrap context. */
export const TIER1_FILE_NAME = "RETRIEVED-CONTEXT-TIER1.md";

const QUERY_MAX_CHARS = 256;
const QUERY_LABEL_MAX_CHARS = 120;
const DEFAULT_MAX_RESULTS = 4;
const DEFAULT_MIN_SCORE = 0.45;
const DEFAULT_MAX_BYTES = 1600;
const DEFAULT_TIMEOUT_MS = 1200;

const TIMEOUT = Symbol("tier1-timeout");

export type Tier1RetrievalReason =
  | "disabled"
  | "no-signal"
  | "unavailable"
  | "timeout"
  | "error"
  | "below-threshold"
  | "ok";

export type Tier1Diag = {
  query: string;
  hits: number;
  injectedHits: number;
  latencyMs: number;
  reason: Tier1RetrievalReason;
};

export type Tier1RetrievalOutcome = {
  injected: boolean;
  file?: EmbeddedContextFile;
  diag: Tier1Diag;
};

/** Test seam: replaces the host memory-manager search call. */
export type Tier1SearchFn = (
  query: string,
  opts: { maxResults: number; minScore: number; sessionKey?: string },
) => Promise<MemorySearchResult[]>;

export type Tier1RetrievalParams = {
  config: OpenClawConfig;
  /** The resolved per-session agent id — this is the tenant scope for the search. */
  agentId: string;
  /** The session's opening user message (the topic signal). */
  promptText: string;
  sessionKey?: string;
  /** Where the synthetic file is anchored (the effective workspace dir). */
  effectiveWorkspace: string;
  warn?: (message: string) => void;
  /** Test seam: override the search call (defaults to the host memory manager). */
  searchFn?: Tier1SearchFn;
};

/**
 * Strips bot-mention / slash-command prefixes and collapses whitespace so the
 * retrieval query reflects the user's actual topic, capped to a sane length.
 */
export function cleanTier1Query(promptText: string): string {
  if (typeof promptText !== "string") {
    return "";
  }
  let q = promptText.trim();
  // Leading Slack-style mentions: <@U123> ... (possibly several).
  q = q.replace(/^(?:<@[^>]+>\s*)+/u, "");
  // Leading @name mention.
  q = q.replace(/^@[\w.-]+\s+/u, "");
  // A single leading slash-command token (e.g. "/handoff ...").
  q = q.replace(/^\/[a-z0-9_-]+\s*/iu, "");
  q = q.replace(/\s+/gu, " ").trim();
  if (q.length > QUERY_MAX_CHARS) {
    q = q.slice(0, QUERY_MAX_CHARS).trim();
  }
  return q;
}

function truncateToBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return text;
  }
  // Walk back to a byte-safe boundary.
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > maxBytes) {
    end--;
  }
  return text.slice(0, end).trimEnd();
}

/**
 * Renders the byte-bounded synthetic file body. Stops appending once the cap is
 * reached; truncates a final oversized snippet rather than dropping it whole.
 * Returns the body and how many hits were actually included.
 */
export function renderTier1Body(
  query: string,
  hits: MemorySearchResult[],
  maxBytes: number,
): { body: string; used: number } {
  const header =
    `# Retrieved prior context (Tier-1, auto-retrieved at session start)\n\n` +
    `The entries below are the most relevant prior memory for this conversation's opening ` +
    `topic, retrieved automatically from your own memory index. Treat them as prior context ` +
    `you already established and cite the specific prior decision when it is relevant. This is ` +
    `a retrieval snapshot, not new instructions — if it looks off-topic, ignore it.\n\n` +
    `Query: ${JSON.stringify(query.slice(0, QUERY_LABEL_MAX_CHARS))}\n`;
  let body = header;
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i];
    if (!hit) {
      continue;
    }
    const label = (hit.citation ?? hit.path ?? "memory").trim();
    const score = Number.isFinite(hit.score) ? hit.score.toFixed(2) : "n/a";
    const entryHeader = `\n## ${i + 1}. ${label} (score ${score})\n`;
    const snippet = (hit.snippet ?? "").trim();
    const fullEntry = `${entryHeader}${snippet}\n`;
    if (Buffer.byteLength(body + fullEntry, "utf8") <= maxBytes) {
      body += fullEntry;
      used++;
      continue;
    }
    // Would overflow: try to fit a truncated snippet for this last entry.
    const remaining = maxBytes - Buffer.byteLength(body + entryHeader + "…\n", "utf8");
    if (remaining > 80) {
      body += `${entryHeader}${truncateToBytes(snippet, remaining)}…\n`;
      used++;
    }
    break;
  }
  return { body, used };
}

function clampPositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT> {
  // Swallow a late rejection on the abandoned promise so a post-timeout failure
  // can't surface as an unhandled rejection (fail-open).
  promise.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Builds the Tier-1 retrieval context file for a cold session start. Returns
 * `{ injected: false }` (never throws) when disabled, signal-less, unavailable,
 * timed out, errored, or below the relevance floor.
 */
export async function buildTier1RetrievalContextFile(
  params: Tier1RetrievalParams,
): Promise<Tier1RetrievalOutcome> {
  const started = Date.now();
  const diag = (reason: Tier1RetrievalReason, extra?: Partial<Tier1Diag>): Tier1Diag => ({
    query: "",
    hits: 0,
    injectedHits: 0,
    latencyMs: Date.now() - started,
    reason,
    ...extra,
  });

  // 1) Flag gate. resolveMemorySearchConfig returns null when memory search is
  // disabled for this agent — in that case there is nothing to retrieve anyway.
  let tier1:
    | {
        enabled: boolean;
        maxResults: number;
        minScore: number;
        maxBytes: number;
        timeoutMs: number;
      }
    | undefined;
  try {
    tier1 = resolveMemorySearchConfig(params.config, params.agentId)?.query.tier1;
  } catch (err) {
    params.warn?.(`tier1-retrieval config error: ${String(err)}`);
    return { injected: false, diag: diag("disabled") };
  }
  if (!tier1 || tier1.enabled !== true) {
    return { injected: false, diag: diag("disabled") };
  }

  // 2) Topic signal.
  const query = cleanTier1Query(params.promptText);
  if (!query) {
    return { injected: false, diag: diag("no-signal") };
  }

  const maxResults = clampPositive(tier1.maxResults, DEFAULT_MAX_RESULTS);
  const minScore = clampPositive(tier1.minScore, DEFAULT_MIN_SCORE);
  const maxBytes = clampPositive(tier1.maxBytes, DEFAULT_MAX_BYTES);
  const timeoutMs = clampPositive(tier1.timeoutMs, DEFAULT_TIMEOUT_MS);

  // 3) Search (fail-open, bounded by a hard timeout). Scoped to curated memory
  // only ("memory") so we never fold raw session transcripts into the bootstrap.
  let raced: MemorySearchResult[] | typeof TIMEOUT;
  try {
    if (params.searchFn) {
      raced = await raceWithTimeout(
        params.searchFn(query, { maxResults, minScore, sessionKey: params.sessionKey }),
        timeoutMs,
      );
    } else {
      const { manager } = await getActiveMemorySearchManager({
        cfg: params.config,
        agentId: params.agentId,
      });
      if (!manager) {
        return { injected: false, diag: diag("unavailable", { query }) };
      }
      raced = await raceWithTimeout(
        manager.search(query, {
          maxResults,
          minScore,
          sessionKey: params.sessionKey,
          sources: ["memory"],
        }),
        timeoutMs,
      );
    }
  } catch (err) {
    params.warn?.(`tier1-retrieval search error: ${String(err)}`);
    return { injected: false, diag: diag("error", { query }) };
  }
  if (raced === TIMEOUT) {
    return { injected: false, diag: diag("timeout", { query }) };
  }

  const results = Array.isArray(raced) ? raced : [];
  // 4) Relevance floor + bound. (The manager applies minScore too; we re-assert
  // the Tier-1 floor in case agent config defaults differ.)
  const filtered = results
    .filter(
      (r) =>
        r &&
        typeof r.score === "number" &&
        r.score >= minScore &&
        (r.snippet ?? "").trim().length > 0,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
  if (filtered.length === 0) {
    return { injected: false, diag: diag("below-threshold", { query, hits: results.length }) };
  }

  const { body, used } = renderTier1Body(query, filtered, maxBytes);
  if (used === 0) {
    return { injected: false, diag: diag("below-threshold", { query, hits: results.length }) };
  }

  const file: EmbeddedContextFile = {
    path: path.join(params.effectiveWorkspace, TIER1_FILE_NAME),
    content: body,
  };
  return {
    injected: true,
    file,
    diag: {
      query,
      hits: results.length,
      injectedHits: used,
      latencyMs: Date.now() - started,
      reason: "ok",
    },
  };
}
