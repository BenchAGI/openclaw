// promote-file — promote an external memory file (e.g. a BenchAGI local-seat
// Claude Code workspace memory) into a native agent memory file under
// <workspaceDir>/memory/seat/, then let the caller reindex it so
// `openclaw memory search --agent <id>` can retrieve it.
//
// This module is intentionally dependency-light (node builtins only) so it is
// unit-testable in isolation and reusable from both the CLI command and a
// future gateway RPC. It does NOT resolve config or build managers itself —
// callers pass the resolved workspace (via the memory manager) so there is a
// single source of workspace resolution and no drift.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

/** Subdirectory under <workspace>/memory where promoted seat memories land. */
const PROMOTED_SUBDIR = "seat";
/** Marker value written into the provenance block; identifies our artifacts. */
const PROMOTION_SOURCE_MARKER = "benchagi-seat-bridge";

type PromoteFileStatus =
  | "created"
  | "updated"
  | "unchanged"
  | "skipped-handauthored"
  | "secret-blocked";

export type PromoteFileSource = {
  /** Absolute path of the originating memory file (provenance only). */
  sourcePath: string;
  /** Raw markdown content of the source file. */
  content: string;
  /** Optional memory type tag for provenance (e.g. feedback|project|user). */
  memoryType?: string;
  /** Source seat/session id for provenance. */
  sourceSessionId?: string;
  /** Provenance label; defaults to "claude-code-seat". */
  sourceLabel?: string;
  /** Originating seat agent id (provenance). */
  sourceAgentId?: string;
  /** Seat kind (claude-code | codex-cli) for provenance. */
  seatKind?: string;
};

type PromoteFileResult = {
  slug: string;
  target: string;
  status: PromoteFileStatus;
  contentHash: string;
  reason?: string;
};

export type PromoteManagerLike = {
  status: () => { workspaceDir?: string | null };
  sync?: (params: { reason?: string; force?: boolean }) => Promise<void>;
};

export type PromoteFileSummary = {
  workspaceDir: string;
  indexed: boolean;
  results: PromoteFileResult[];
};

// --- frontmatter helpers (minimal; no YAML dependency) -----------------------

/** Split a markdown document into its leading YAML frontmatter and body. */
/**
 * @public Bench fork: exercised directly by its test.
 */
export function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (match) {
    return { frontmatter: match[1] ?? "", body: match[2] ?? "" };
  }
  return { frontmatter: null, body: raw };
}

/** Read a top-level or nested scalar from a frontmatter block by key name. */
function readFrontmatterField(frontmatter: string | null, key: string): string | undefined {
  if (!frontmatter) {
    return undefined;
  }
  // Match `key: value` at any indentation; tolerate quotes.
  const re = new RegExp(`^[\\t ]*${escapeRegExp(key)}:[\\t ]*(.+?)[\\t ]*$`, "m");
  const m = frontmatter.match(re);
  if (!m) {
    return undefined;
  }
  return unquoteScalar(m[1] ?? "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquoteScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    try {
      return JSON.parse(trimmed.startsWith("'") ? `"${trimmed.slice(1, -1)}"` : trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** True only for files we previously wrote (carry our promotion marker). */
/**
 * @public Bench fork: exercised directly by its test.
 */
export function isPromotedArtifact(existing: string): boolean {
  const { frontmatter } = splitFrontmatter(existing);
  if (!frontmatter) {
    return false;
  }
  return readFrontmatterField(frontmatter, "source") === PROMOTION_SOURCE_MARKER;
}

// --- slug + hash -------------------------------------------------------------

/** Deterministic, traversal-safe slug from frontmatter `name` or basename. */
/**
 * @public Bench fork: exercised directly by its test.
 */
export function promotionSlug(sourcePath: string, frontmatterName?: string): string {
  const base =
    (frontmatterName && frontmatterName.trim()) || path.basename(sourcePath).replace(/\.md$/i, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, "-") // collapse any `..` so it can never form a traversal segment
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 120);
  return slug || "memory";
}

/** sha256 of the normalized source content; the dedup key. */
/**
 * @public Bench fork: exercised directly by its test.
 */
export function contentHashOf(content: string): string {
  const normalized = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/, ""))
    .join("\n")
    .replace(/\n+$/, "\n")
    .trim();
  return createHash("sha256").update(normalized).digest("hex");
}

function shortSourceHash(sourcePath: string): string {
  return createHash("sha1").update(sourcePath).digest("hex").slice(0, 6);
}

// --- secret guard ------------------------------------------------------------

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "pem-private-key", re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/ },
  { name: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { name: "bearer-jwt", re: /\bBearer\s+eyJ[A-Za-z0-9._-]{20,}/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\b/ },
];

/**
 * Detect high-confidence secret VALUES (not prose mentioning "token").
 * Returns the matched pattern names only — never the matched span — so callers
 * can log/report a block without leaking the secret.
 * @public Bench fork: exercised directly by its test.
 */
export function detectSecrets(content: string): string[] {
  const hits: string[] = [];
  for (const { name, re } of SECRET_PATTERNS) {
    if (re.test(content)) {
      hits.push(name);
    }
  }
  return hits;
}

// --- provenance rendering ----------------------------------------------------

function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

function buildPromotionBlock(args: {
  sourceLabel: string;
  seatKind?: string;
  sourceAgentId?: string;
  sourceSessionId?: string;
  sourcePath: string;
  sourceHash: string;
  promotedAt: string;
  memoryType?: string;
  promoterVersion: string;
}): string {
  const lines = [
    "promotion:",
    `  source: ${yamlScalar(PROMOTION_SOURCE_MARKER)}`,
    `  sourceLabel: ${yamlScalar(args.sourceLabel)}`,
  ];
  if (args.seatKind) {
    lines.push(`  seatKind: ${yamlScalar(args.seatKind)}`);
  }
  if (args.sourceAgentId) {
    lines.push(`  agentId: ${yamlScalar(args.sourceAgentId)}`);
  }
  if (args.sourceSessionId) {
    lines.push(`  seatSessionId: ${yamlScalar(args.sourceSessionId)}`);
  }
  lines.push(`  sourcePath: ${yamlScalar(args.sourcePath)}`);
  lines.push(`  sourceHash: ${yamlScalar(args.sourceHash)}`);
  lines.push(`  promotedAt: ${yamlScalar(args.promotedAt)}`);
  if (args.memoryType) {
    lines.push(`  memoryType: ${yamlScalar(args.memoryType)}`);
  }
  lines.push(`  status: promoted`);
  lines.push(`  promoterVersion: ${yamlScalar(args.promoterVersion)}`);
  return lines.join("\n");
}

/**
 * Produce the promoted file content: the source verbatim with a `promotion:`
 * block injected into its frontmatter (or a fresh frontmatter if it had none).
 * Source frontmatter fields (name/description/type/originSessionId) are
 * preserved untouched — no YAML re-serialization.
 * @public Bench fork: exercised directly by its test.
 */
export function renderPromotedMemory(source: PromoteFileSource, promotionBlock: string): string {
  const { frontmatter, body } = splitFrontmatter(source.content);
  if (frontmatter !== null) {
    return `---\n${frontmatter.replace(/\n+$/, "")}\n${promotionBlock}\n---\n${body}`;
  }
  return `---\n${promotionBlock}\n---\n\n${source.content}`;
}

// --- writer ------------------------------------------------------------------

const DEFAULT_PROMOTER_VERSION = "memory-core/promote-file@1";

/**
 * Write one promoted memory file under <workspaceDir>/memory/seat/.
 * Idempotent: deterministic target by slug; content-hash skip; full-file
 * replace (never append); refuses to clobber hand-authored memory; suffixes
 * the slug on a cross-source collision. Does NOT reindex (caller syncs once).
 * @public Bench fork: exercised directly by its test.
 */
export async function writePromotedMemoryFile(args: {
  workspaceDir: string;
  source: PromoteFileSource;
  now?: () => Date;
  promoterVersion?: string;
}): Promise<PromoteFileResult> {
  const { workspaceDir, source } = args;
  const contentHash = contentHashOf(source.content);
  const fm = splitFrontmatter(source.content).frontmatter;
  const nameField = readFrontmatterField(fm, "name");
  const seatDir = path.join(workspaceDir, "memory", PROMOTED_SUBDIR);

  // Secret guard runs before any write/log. Block (do not silently redact).
  const secrets = detectSecrets(source.content);
  if (secrets.length > 0) {
    const slug = promotionSlug(source.sourcePath, nameField);
    return {
      slug,
      target: path.join(seatDir, `${slug}.md`),
      status: "secret-blocked",
      contentHash,
      reason: `secret_guard_blocked:${secrets.join(",")}`,
    };
  }

  // Resolve a target path, suffixing the slug on cross-source slug collision.
  let slug = promotionSlug(source.sourcePath, nameField);
  let target = path.join(seatDir, `${slug}.md`);
  let existing = await readIfExists(target);
  if (existing != null && isPromotedArtifact(existing)) {
    const prevSource = readFrontmatterField(splitFrontmatter(existing).frontmatter, "sourcePath");
    if (prevSource && prevSource !== source.sourcePath) {
      slug = `${slug}--${shortSourceHash(source.sourcePath)}`;
      target = path.join(seatDir, `${slug}.md`);
      existing = await readIfExists(target);
    }
  }

  // Defense-in-depth: the resolved target must stay under the seat dir.
  const resolvedTarget = path.resolve(target);
  const resolvedSeatDir = path.resolve(seatDir);
  if (!resolvedTarget.startsWith(resolvedSeatDir + path.sep)) {
    throw new Error(`promote-file: refusing to write outside seat dir: ${target}`);
  }

  if (existing != null) {
    if (!isPromotedArtifact(existing)) {
      return { slug, target, status: "skipped-handauthored", contentHash };
    }
    const prevHash = readFrontmatterField(splitFrontmatter(existing).frontmatter, "sourceHash");
    if (prevHash === contentHash) {
      return { slug, target, status: "unchanged", contentHash };
    }
  }

  const now = (args.now ?? (() => new Date()))();
  const promotionBlock = buildPromotionBlock({
    sourceLabel: source.sourceLabel ?? "claude-code-seat",
    seatKind: source.seatKind,
    sourceAgentId: source.sourceAgentId,
    sourceSessionId: source.sourceSessionId,
    sourcePath: source.sourcePath,
    sourceHash: contentHash,
    promotedAt: now.toISOString(),
    memoryType: source.memoryType ?? readFrontmatterField(fm, "type"),
    promoterVersion: args.promoterVersion ?? DEFAULT_PROMOTER_VERSION,
  });
  const out = renderPromotedMemory(source, promotionBlock);

  await fs.mkdir(seatDir, { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp-${process.pid}`;
  await fs.writeFile(tmp, out, { mode: 0o600 });
  await fs.rename(tmp, target);
  return { slug, target, status: existing != null ? "updated" : "created", contentHash };
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/**
 * Promote a batch of sources into one agent's native memory, then reindex once
 * if anything was written. Shared by the CLI command and the gateway RPC.
 */
export async function promoteFileToAgentMemory(args: {
  manager: PromoteManagerLike;
  sources: PromoteFileSource[];
  force?: boolean;
  now?: () => Date;
  promoterVersion?: string;
}): Promise<PromoteFileSummary> {
  const workspaceDir = args.manager.status().workspaceDir?.trim();
  if (!workspaceDir) {
    throw new Error("promote-file requires a resolvable workspace directory");
  }
  const results: PromoteFileResult[] = [];
  let wrote = false;
  for (const source of args.sources) {
    const result = await writePromotedMemoryFile({
      workspaceDir,
      source,
      now: args.now,
      promoterVersion: args.promoterVersion,
    });
    results.push(result);
    if (result.status === "created" || result.status === "updated") {
      wrote = true;
    }
  }
  if (wrote && args.manager.sync) {
    await args.manager.sync({ reason: "cli-promote", force: Boolean(args.force) });
  }
  return { workspaceDir, indexed: wrote, results };
}
