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
 *  - FLAG-GATED: `memory.search.query.tier1.enabled` (or `agents.entries.*.memory.search.query.tier1.enabled`) (default OFF).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import { getActiveMemorySearchManager } from "../plugin-sdk/memory-host-search.js";
import { materializeSecretInput } from "../secrets/resolve-secret-input-string.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import type { EmbeddedContextFile } from "./embedded-agent-helpers.js";
import { resolveMemorySearchConfig } from "./memory-search.js";

/** Synthetic file name; prepended ahead of MEMORY.md in the bootstrap context. */
export const TIER1_FILE_NAME = "RETRIEVED-CONTEXT-TIER1.md";

/** Durable observability trace, independent of subsystem log routing. */
const TIER1_DIAG_LOG = path.join(os.homedir(), ".openclaw", "logs", "tier1-retrieval.jsonl");

function appendTier1DiagLine(line: string): void {
  mkdirSync(path.dirname(TIER1_DIAG_LOG), { recursive: true });
  appendFileSync(TIER1_DIAG_LOG, line);
}

/**
 * Best-effort observability: append one diagnostic line to TIER1_DIAG_LOG so F1
 * firing is verifiable even though the gateway sends agent stderr to /dev/null.
 * Never throws — observability must not affect a turn.
 */
export function recordTier1Diag(
  diag: Tier1Diag,
  ctx: { sessionKey?: string; agentId: string },
): void {
  try {
    const line = `${JSON.stringify({
      at: new Date().toISOString(),
      sessionKey: ctx.sessionKey ?? null,
      agentId: ctx.agentId,
      ...diag,
    })}\n`;
    appendTier1DiagLine(line);
  } catch {
    // best-effort trace; a write failure must never affect the session
  }
}

const QUERY_MAX_CHARS = 256;
const QUERY_LABEL_MAX_CHARS = 120;
const DEFAULT_MAX_RESULTS = 4;
const DEFAULT_MIN_SCORE = 0.45;
const DEFAULT_MAX_BYTES = 1600;
const DEFAULT_TIMEOUT_MS = 1200;
/** Hard ceilings for caller-supplied overrides — Tier-1 stays small by contract. */
const MAX_RESULTS_OVERRIDE_CAP = 8;
const MAX_BYTES_OVERRIDE_CAP = 8192;

const TIMEOUT = Symbol("tier1-timeout");

type Tier1RetrievalReason =
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
  /** Diagnostic detail on the "error" path (the caught exception message). */
  err?: string;
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
  /** Optional caller override for max hits (clamped to MAX_RESULTS_OVERRIDE_CAP). */
  maxResultsOverride?: number;
  /** Optional caller override for the body byte cap (clamped to MAX_BYTES_OVERRIDE_CAP). */
  maxBytesOverride?: number;
};

/**
 * Strips bot-mention / slash-command prefixes and collapses whitespace so the
 * retrieval query reflects the user's actual topic, capped to a sane length.
 * @public Bench fork: exercised directly by its test.
 */
export function cleanTier1Query(promptText: string): string {
  if (typeof promptText !== "string") {
    return "";
  }
  let q = promptText;
  // The Slack relay wraps the real message behind a large preamble that ends with
  // a "## Message (user-controlled text...)" marker; the actual user text follows.
  // Search only that — otherwise we'd embed the whole ~8KB preamble (garbage query
  // + the embedder rejects it). No marker (CLI/web) -> use the text as-is.
  const markerIdx = q.lastIndexOf("## Message (user-controlled text");
  if (markerIdx !== -1) {
    const afterMarker = q.slice(markerIdx);
    const nl = afterMarker.indexOf("\n");
    q = nl !== -1 ? afterMarker.slice(nl + 1) : "";
  }
  q = q.trim();
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
 * @public Bench fork: exercised directly by its test.
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

/** Caller overrides are optional and hard-capped; invalid values fall back to config. */
function clampOverride(value: number | undefined, cap: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.min(Math.floor(value), cap);
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
  let reranker:
    | {
        enabled: boolean;
        baseUrl?: string;
        apiKey?: SecretInput;
        model?: string;
        timeoutMs: number;
        minScore: number;
        topK: number;
      }
    | undefined;
  try {
    const rq = resolveMemorySearchConfig(params.config, params.agentId)?.query;
    tier1 = rq?.tier1;
    reranker = rq?.reranker;
  } catch (err) {
    params.warn?.(`tier1-retrieval config error: ${String(err)}`);
    return { injected: false, diag: diag("disabled") };
  }
  if (!tier1?.enabled) {
    return { injected: false, diag: diag("disabled") };
  }

  // 2) Topic signal.
  const query = cleanTier1Query(params.promptText);
  if (!query) {
    return { injected: false, diag: diag("no-signal") };
  }

  const maxResults =
    clampOverride(params.maxResultsOverride, MAX_RESULTS_OVERRIDE_CAP) ??
    clampPositive(tier1.maxResults, DEFAULT_MAX_RESULTS);
  const minScore = clampPositive(tier1.minScore, DEFAULT_MIN_SCORE);
  const maxBytes =
    clampOverride(params.maxBytesOverride, MAX_BYTES_OVERRIDE_CAP) ??
    clampPositive(tier1.maxBytes, DEFAULT_MAX_BYTES);
  const timeoutMs = clampPositive(tier1.timeoutMs, DEFAULT_TIMEOUT_MS);

  // 3) Search (fail-open, bounded by a hard timeout). Scoped to curated memory
  // only ("memory") so we never fold raw session transcripts into the bootstrap.
  let raced: MemorySearchResult[] | null | typeof TIMEOUT;
  try {
    const searchPromise: Promise<MemorySearchResult[] | null> = params.searchFn
      ? params.searchFn(query, { maxResults, minScore, sessionKey: params.sessionKey })
      : (async () => {
          const { manager } = await getActiveMemorySearchManager({
            cfg: params.config,
            agentId: params.agentId,
          });
          if (!manager) {
            return null;
          }
          return manager.search(query, {
            maxResults,
            minScore,
            sessionKey: params.sessionKey,
            sources: ["memory"],
          });
        })();
    raced = await raceWithTimeout(searchPromise, timeoutMs);
  } catch (err) {
    params.warn?.(`tier1-retrieval search error: ${String(err)}`);
    return { injected: false, diag: diag("error", { query, err: String(err).slice(0, 240) }) };
  }
  if (raced === TIMEOUT) {
    return { injected: false, diag: diag("timeout", { query }) };
  }
  if (raced === null) {
    return { injected: false, diag: diag("unavailable", { query }) };
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
    .toSorted((a, b) => b.score - a.score)
    .slice(0, maxResults);
  if (filtered.length === 0) {
    return { injected: false, diag: diag("below-threshold", { query, hits: results.length }) };
  }

  // 4b) Optional LLM rerank: a judge model re-orders/filters the cosine candidates by
  // "does this actually answer THIS question?" (catches topically-adjacent hard negatives the
  // embedder can't separate). FAIL-OPEN: any error/timeout/empty returns the original cosine
  // order — the rerank can refine, never drop, retrieval.
  let ranked = filtered;
  if (reranker?.enabled) {
    ranked = await rerankTier1Candidates(
      query,
      filtered,
      { ...reranker, config: params.config },
      params.warn,
    );
  }

  const { body, used } = renderTier1Body(query, ranked, maxBytes);
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

/**
 * LLM reranker: ask a local or OpenAI-compatible judge model to
 * score each candidate for whether it answers THIS query, re-sort by judge score, and drop
 * below cfg.minScore. Catches the topically-adjacent hard negatives the embedder alone can't
 * separate. FAIL-OPEN: on any error/timeout/empty/invalid response it returns the input
 * candidates unchanged — the rerank can refine, never drop, retrieval. Bounded by cfg.timeoutMs.
 * @public Bench fork: exercised directly by its test.
 */
export async function rerankTier1Candidates(
  query: string,
  candidates: MemorySearchResult[],
  cfg: {
    baseUrl?: string;
    apiKey?: SecretInput;
    config?: OpenClawConfig;
    model?: string;
    timeoutMs: number;
    minScore: number;
    topK: number;
  },
  warn?: (msg: string) => void,
): Promise<MemorySearchResult[]> {
  if (!cfg.baseUrl || !cfg.model || candidates.length <= 1) {
    return candidates;
  }
  const configuredApiKey = await resolveTier1RerankerApiKey(cfg, warn);
  if (configuredApiKey === null) {
    return candidates;
  }
  const top = candidates.slice(0, Math.max(1, cfg.topK));
  const sys =
    "You are a memory-relevance judge for a retrieval system. Given a user QUESTION and candidate " +
    "memory snippets, score each from 0.0 to 1.0 for whether it actually HELPS ANSWER THIS SPECIFIC " +
    "QUESTION. Penalize snippets that are merely topically adjacent but do not answer it. Respond " +
    'with STRICT JSON only: {"scores":[{"id":<int>,"score":<0.0-1.0>}]}, one entry per candidate, ' +
    "preserving the given ids.";
  const enumerated = top
    .map((c, i) => `- id ${i}: ${(c.snippet ?? "").replace(/\s+/g, " ").slice(0, 700)}`)
    .join("\n");
  const user = `QUESTION:\n${query}\n\nCANDIDATES:\n${enumerated}\n\nScore every candidate.`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, cfg.timeoutMs));
  try {
    const res = await fetch(`${cfg.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${configuredApiKey ?? "ollama"}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      warn?.(`tier1 reranker HTTP ${res.status}`);
      return candidates;
    }
    const payload = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = payload?.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      return candidates;
    }
    const parsed = JSON.parse(match[0]) as { scores?: Array<{ id?: unknown; score?: unknown }> };
    const scores = Array.isArray(parsed?.scores) ? parsed.scores : [];
    const judgeById = new Map<number, number>();
    for (const entry of scores) {
      const id = Number(entry?.id);
      const score = Number(entry?.score);
      if (Number.isInteger(id) && id >= 0 && id < top.length && Number.isFinite(score)) {
        judgeById.set(id, score);
      }
    }
    if (judgeById.size === 0) {
      return candidates;
    }
    const reordered = top
      .map((c, i) => ({ c, judge: judgeById.has(i) ? (judgeById.get(i) as number) : -1 }))
      .filter((x) => x.judge >= cfg.minScore)
      .toSorted((a, b) => b.judge - a.judge)
      .map((x) => x.c);
    // FAIL-OPEN: if the judge floor emptied the set, keep the original cosine order.
    return reordered.length > 0 ? reordered : candidates;
  } catch (err) {
    warn?.(`tier1 reranker error: ${String(err).slice(0, 160)}`);
    return candidates;
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTier1RerankerApiKey(
  cfg: { apiKey?: SecretInput; config?: OpenClawConfig },
  warn?: (msg: string) => void,
): Promise<string | null | undefined> {
  if (cfg.apiKey === undefined) {
    return undefined;
  }
  if (!cfg.config) {
    const normalized = normalizeSecretInput(cfg.apiKey);
    if (!normalized) {
      warn?.("tier1 reranker apiKey is configured but unresolved; skipping reranker");
    }
    return normalized || null;
  }
  try {
    const resolved = await materializeSecretInput({
      config: cfg.config,
      value: cfg.apiKey,
      env: process.env,
      normalize: (value: unknown) => normalizeSecretInput(value) || undefined,
    });
    if (!resolved) {
      warn?.("tier1 reranker apiKey is configured but unresolved; skipping reranker");
      return null;
    }
    return resolved;
  } catch (err) {
    warn?.(
      `tier1 reranker apiKey resolution error; skipping reranker: ${String(err).slice(0, 160)}`,
    );
    return null;
  }
}
