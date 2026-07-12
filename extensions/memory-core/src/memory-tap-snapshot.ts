// Memory Tap exposes a bounded, privacy-preserving view of native dreaming artifacts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import {
  resolveMemorySearchConfig,
  truncateUtf16Safe,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveMemoryBackendConfig } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import {
  listMemoryWorkspacePublicArtifacts,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-host-core";
import { resolveDreamsPath } from "./dreaming-dreams-file.js";
import { readRecentDreamDiaryRecords } from "./dreaming-narrative.js";
import {
  MEMORY_TAP_MIN_QUOTE_CHARS,
  type MemoryTapCandidateKind,
  type MemoryTapHealthCheck,
  type MemoryTapHealthStatus,
  type MemoryTapSnapshot,
  type MemoryTapSnapshotCandidate,
  type MemoryTapSnapshotParams,
} from "./memory-tap-contract.js";
import {
  loadShortTermPromotionPhaseHitCounts,
  readShortTermRecallEntries,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";

const MAX_DIARY_SCAN = 100;
const MAX_SIGNAL_COUNT = 10_000;
const SESSION_EVIDENCE_PATH_RE =
  /^memory\/\.dreams\/session-corpus\/(\d{4}-\d{2}-\d{2})\.(?:md|txt)$/i;
const DAILY_MEMORY_PATH_RE = /^memory\/(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i;
const OPAQUE_TOKEN_RE = /(?:^|[^\p{L}\p{N}])[A-Za-z0-9_+/=-]{48,}(?:$|[^\p{L}\p{N}])/u;
const SELF_INGESTION_RE =
  /(?:write a dream diary entry from these memory fragments|dreaming-narrative|__openclaw_memory_core_[a-z_]+_dream__|memory[-_. ]?tap|forgePackets|memoryTapRuns)/i;
const LOCAL_PATH_PATTERNS = [
  /(?:^|[\s"'`([{=:])(?:~\/|file:\/\/|\/(?!\/)(?:[^\s/]+\/)+[^\s/]*)/i,
  /(?:^|[\s"'`([{=:])(?:[A-Za-z]:\\[^\s]+|[A-Za-z]:\/[^\s]+|\\\\[^\\\s]+\\[^\\\s]+)/i,
  /(?:^|[\s"'`([{=])\/\/[^/\s]+\/[^\s]+/i,
];
const RAW_IDENTITY_RE =
  /\b(?:raw[-_ ]?(?:identit(?:y|ies)|transcripts?|sessions?)|session[-_ ]?(?:transcripts?|ids?|markers?|keys?|files?|paths?)|tenant[-_ ]?(?:ids?|markers?)|instance[-_ ]?ids?|customer[-_ ]?ids?|absolute[-_ ]?paths?)\b/i;

type SnapshotWindow = {
  sinceMs: number;
  untilMs: number;
};

type CollectedCandidate = MemoryTapSnapshotCandidate & {
  observedAtMs: number;
  recencyOrdinal: number;
};

type SecretFilterCounter = {
  count: number;
};

type SelfIngestionFilterCounter = {
  count: number;
};

type RawEvidenceFilterCounter = {
  count: number;
};

type ArtifactHealth = {
  status: MemoryTapHealthStatus;
  detail: string;
  fresh: boolean;
  required: boolean;
};

export type MemoryTapSearchHealth = {
  status: MemoryTapHealthStatus;
  detail:
    | "hybrid search configured"
    | "vector search configured"
    | "full-text-only search configured"
    | "search unavailable";
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isWithinWindow(timestampMs: number, window: SnapshotWindow): boolean {
  return timestampMs >= window.sinceMs && timestampMs < window.untilMs;
}

function truncateExcerpt(value: string, maxChars: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${truncateUtf16Safe(normalized, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function safeExcerpt(
  value: string,
  maxChars: number,
  filtered: SecretFilterCounter,
  selfIngestionFiltered: SelfIngestionFilterCounter,
  rawEvidenceFiltered: RawEvidenceFilterCounter,
): string | null {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  if (SELF_INGESTION_RE.test(normalized)) {
    selfIngestionFiltered.count += 1;
    return null;
  }
  if (
    LOCAL_PATH_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    RAW_IDENTITY_RE.test(normalized)
  ) {
    rawEvidenceFiltered.count += 1;
    return null;
  }
  const redacted = redactToolPayloadText(normalized);
  // Memory Tap hard-drops the entire item when the shared redactor detects a secret;
  // partial redaction would still disclose token shape and surrounding sensitive context.
  if (redacted !== normalized || OPAQUE_TOKEN_RE.test(normalized)) {
    filtered.count += 1;
    return null;
  }
  return truncateExcerpt(normalized, maxChars);
}

function zeroSignals(): MemoryTapSnapshotCandidate["signals"] {
  return {
    recallCount: 0,
    dailyCount: 0,
    groundedCount: 0,
    phaseHitCount: 0,
  };
}

function clampSignalCount(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(MAX_SIGNAL_COUNT, Math.floor(value)));
}

function clampLineNumber(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)));
}

function buildCandidate(params: {
  kind: MemoryTapSnapshotCandidate["kind"];
  excerpt: string;
  observedAtMs: number;
  ref: string;
  evidenceDigest: string;
  signals: MemoryTapSnapshotCandidate["signals"];
  recencyOrdinal?: number;
}): CollectedCandidate {
  const id = digest(`${params.kind}\n${params.ref}\n${params.evidenceDigest}`).slice(0, 24);
  return {
    id,
    kind: params.kind,
    excerpt: params.excerpt,
    observedAt: new Date(params.observedAtMs).toISOString(),
    observedAtMs: params.observedAtMs,
    recencyOrdinal: params.recencyOrdinal ?? 0,
    signals: params.signals,
    provenance: {
      ref: params.ref,
      digest: params.evidenceDigest,
    },
  };
}

async function readRegularFileMtime(filePath: string): Promise<number | null> {
  const stat = await fs.lstat(filePath).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (!stat || stat.isSymbolicLink() || !stat.isFile()) {
    return null;
  }
  return Math.floor(stat.mtimeMs);
}

async function collectDiary(params: {
  workspaceDir: string;
  window: SnapshotWindow;
  maxCandidates: number;
  maxQuoteChars: number;
  includeCandidates: boolean;
  filtered: SecretFilterCounter;
  selfIngestionFiltered: SelfIngestionFilterCounter;
  rawEvidenceFiltered: RawEvidenceFilterCounter;
}): Promise<{
  candidates: CollectedCandidate[];
  health: ArtifactHealth;
  examined: number;
}> {
  const dreamsPath = await resolveDreamsPath(params.workspaceDir);
  const updatedAtMs = await readRegularFileMtime(dreamsPath);
  if (updatedAtMs === null) {
    return {
      candidates: [],
      health: { status: "warn", detail: "not present", fresh: false, required: true },
      examined: 0,
    };
  }
  const diaryFresh = isWithinWindow(updatedAtMs, params.window);
  let entries;
  try {
    entries = await readRecentDreamDiaryRecords({
      workspaceDir: params.workspaceDir,
      limit: MAX_DIARY_SCAN,
    });
  } catch {
    return {
      candidates: [],
      health: { status: "error", detail: "unreadable", fresh: false, required: true },
      examined: 0,
    };
  }
  if (!params.includeCandidates) {
    return {
      candidates: [],
      health: diaryFresh
        ? { status: "ok", detail: "fresh", fresh: true, required: true }
        : {
            status: "warn",
            detail: "present but outside requested window",
            fresh: false,
            required: true,
          },
      examined: 0,
    };
  }
  const candidates: CollectedCandidate[] = [];
  let examined = 0;
  for (const [index, entry] of entries.entries()) {
    // Legacy blocks without a parseable embedded timestamp may use the file
    // mtime only when they are the newest block. Appending a new entry must not
    // make every older legacy dream look newly observed.
    const rawObservedAtMs =
      entry.observedAtMs ?? (index === 0 && diaryFresh ? updatedAtMs : Number.NaN);
    const overlapsWindow =
      Number.isFinite(rawObservedAtMs) &&
      rawObservedAtMs < params.window.untilMs &&
      rawObservedAtMs + entry.precisionMs > params.window.sinceMs;
    if (!overlapsWindow) {
      continue;
    }
    // Legacy human timestamps had minute precision. Clamp their representative
    // instant into the requested window. The production carrier uses
    // minute-aligned adjacent windows so this interval belongs to one run.
    const observedAtMs = Math.max(rawObservedAtMs, params.window.sinceMs);
    examined += 1;
    const excerpt = safeExcerpt(
      entry.text,
      params.maxQuoteChars,
      params.filtered,
      params.selfIngestionFiltered,
      params.rawEvidenceFiltered,
    );
    if (!excerpt) {
      continue;
    }
    const evidenceDigest = digest(entry.text);
    candidates.push(
      buildCandidate({
        kind: "dream",
        excerpt,
        observedAtMs,
        ref: `dreams://diary/${evidenceDigest}`,
        evidenceDigest,
        signals: zeroSignals(),
        recencyOrdinal: index,
      }),
    );
  }
  return {
    candidates,
    health: {
      status: diaryFresh ? "ok" : "warn",
      detail: diaryFresh
        ? entries.length === 0
          ? "fresh with no diary entries"
          : `fresh; entries=${entries.length}`
        : "present but outside requested window",
      fresh: diaryFresh,
      required: true,
    },
    examined,
  };
}

async function inspectDreamReports(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  window: SnapshotWindow;
}): Promise<ArtifactHealth> {
  const dreaming = resolveMemoryDreamingConfig({
    cfg: params.cfg,
    pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
  });
  const reportsExpected =
    dreaming.storage.mode === "separate" ||
    dreaming.storage.mode === "both" ||
    dreaming.storage.separateReports;
  if (!reportsExpected) {
    return {
      status: "ok",
      detail: "not required by storage mode",
      fresh: false,
      required: false,
    };
  }
  const artifacts = await listMemoryWorkspacePublicArtifacts({
    workspaceDir: params.workspaceDir,
    agentIds: [params.agentId],
  });
  const reportMtimes = await Promise.all(
    artifacts
      .filter((artifact) => artifact.kind === "dream-report")
      .map((artifact) => readRegularFileMtime(artifact.absolutePath)),
  );
  const latest = reportMtimes
    .filter((value): value is number => value !== null)
    .toSorted((left, right) => right - left)[0];
  if (latest === undefined) {
    return { status: "warn", detail: "not present", fresh: false, required: true };
  }
  if (!isWithinWindow(latest, params.window)) {
    return {
      status: "warn",
      detail: "present but outside requested window",
      fresh: false,
      required: true,
    };
  }
  return { status: "ok", detail: "fresh", fresh: true, required: true };
}

function entrySignals(
  entry: ShortTermRecallEntry,
  phaseHitCounts: ReadonlyMap<string, number>,
): MemoryTapSnapshotCandidate["signals"] {
  return {
    recallCount: clampSignalCount(entry.recallCount),
    dailyCount: clampSignalCount(entry.dailyCount),
    groundedCount: clampSignalCount(entry.groundedCount),
    phaseHitCount: clampSignalCount(phaseHitCounts.get(entry.key) ?? 0),
  };
}

function mergeSignals(
  target: MemoryTapSnapshotCandidate["signals"],
  source: MemoryTapSnapshotCandidate["signals"],
): void {
  target.recallCount = clampSignalCount(target.recallCount + source.recallCount);
  target.dailyCount = clampSignalCount(target.dailyCount + source.dailyCount);
  target.groundedCount = clampSignalCount(target.groundedCount + source.groundedCount);
  target.phaseHitCount = clampSignalCount(target.phaseHitCount + source.phaseHitCount);
}

function collectEvidence(params: {
  entries: ShortTermRecallEntry[];
  window: SnapshotWindow;
  maxQuoteChars: number;
  kinds: ReadonlySet<MemoryTapCandidateKind>;
  phaseHitCounts: ReadonlyMap<string, number>;
  filtered: SecretFilterCounter;
  selfIngestionFiltered: SelfIngestionFilterCounter;
  rawEvidenceFiltered: RawEvidenceFilterCounter;
}): {
  candidates: CollectedCandidate[];
  memoryCount: number;
  sessionCount: number;
  examined: number;
} {
  const candidates: CollectedCandidate[] = [];
  const sessionByDay = new Map<
    string,
    {
      latestMs: number;
      entryDigests: string[];
      signals: MemoryTapSnapshotCandidate["signals"];
      count: number;
    }
  >();
  let memoryCount = 0;
  let sessionCount = 0;
  let examined = 0;

  for (const entry of params.entries) {
    const observedAtMs = Date.parse(entry.lastRecalledAt);
    if (!Number.isFinite(observedAtMs) || !isWithinWindow(observedAtMs, params.window)) {
      continue;
    }
    const sessionMatch = SESSION_EVIDENCE_PATH_RE.exec(entry.path);
    if (sessionMatch && params.kinds.has("session")) {
      examined += 1;
      const safeSessionEvidence = safeExcerpt(
        entry.snippet,
        MEMORY_TAP_MIN_QUOTE_CHARS,
        params.filtered,
        params.selfIngestionFiltered,
        params.rawEvidenceFiltered,
      );
      if (!safeSessionEvidence) {
        continue;
      }
      const day = sessionMatch[1];
      const group = sessionByDay.get(day) ?? {
        latestMs: observedAtMs,
        entryDigests: [],
        signals: zeroSignals(),
        count: 0,
      };
      group.latestMs = Math.max(group.latestMs, observedAtMs);
      group.entryDigests.push(digest(`${entry.key}\n${entry.snippet}`));
      mergeSignals(group.signals, entrySignals(entry, params.phaseHitCounts));
      group.count += 1;
      sessionByDay.set(day, group);
      sessionCount += 1;
      continue;
    }
    const dailyMatch = DAILY_MEMORY_PATH_RE.exec(entry.path);
    if (!dailyMatch || !params.kinds.has("memory")) {
      continue;
    }
    examined += 1;
    const excerpt = safeExcerpt(
      entry.snippet,
      params.maxQuoteChars,
      params.filtered,
      params.selfIngestionFiltered,
      params.rawEvidenceFiltered,
    );
    if (!excerpt) {
      continue;
    }
    memoryCount += 1;
    const day = dailyMatch[1];
    const startLine = clampLineNumber(entry.startLine);
    const endLine = Math.max(startLine, clampLineNumber(entry.endLine));
    const evidenceDigest = digest(`${entry.key}\n${entry.snippet}`);
    candidates.push(
      buildCandidate({
        kind: "memory",
        excerpt,
        observedAtMs,
        ref: `memory://daily/${day}#L${startLine}-L${endLine}`,
        evidenceDigest,
        signals: entrySignals(entry, params.phaseHitCounts),
      }),
    );
  }

  for (const day of [...sessionByDay.keys()].toSorted()) {
    const group = sessionByDay.get(day);
    if (!group) {
      continue;
    }
    const evidenceDigest = digest(group.entryDigests.toSorted().join("\n"));
    candidates.push(
      buildCandidate({
        kind: "session",
        excerpt: truncateExcerpt(
          `Indexed session evidence (${group.count}).`,
          params.maxQuoteChars,
        ),
        observedAtMs: group.latestMs,
        ref: `sessions://indexed/${day}`,
        evidenceDigest,
        signals: group.signals,
      }),
    );
  }

  return { candidates, memoryCount, sessionCount, examined };
}

function compareCandidates(left: CollectedCandidate, right: CollectedCandidate): number {
  if (right.observedAtMs !== left.observedAtMs) {
    return right.observedAtMs - left.observedAtMs;
  }
  const kindOrder = { dream: 0, session: 1, memory: 2 } as const;
  if (kindOrder[left.kind] !== kindOrder[right.kind]) {
    return kindOrder[left.kind] - kindOrder[right.kind];
  }
  if (left.recencyOrdinal !== right.recencyOrdinal) {
    return left.recencyOrdinal - right.recencyOrdinal;
  }
  return left.id.localeCompare(right.id);
}

function dedupeCandidates(candidates: CollectedCandidate[]): CollectedCandidate[] {
  const seen = new Set<string>();
  const deduped: CollectedCandidate[] = [];
  for (const candidate of candidates.toSorted(compareCandidates)) {
    const key = `${candidate.kind}:${candidate.provenance.digest}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(candidate);
  }
  return deduped;
}

export function inspectMemoryTapSearchHealth(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): MemoryTapSearchHealth {
  const backend = resolveMemoryBackendConfig(params);
  if (backend.backend === "qmd") {
    if (backend.qmd?.searchMode === "search") {
      return { status: "warn", detail: "full-text-only search configured" };
    }
    return backend.qmd?.searchMode === "vsearch"
      ? { status: "ok", detail: "vector search configured" }
      : { status: "ok", detail: "hybrid search configured" };
  }

  const memory = resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!memory) {
    return { status: "error", detail: "search unavailable" };
  }
  const fullTextEnabled = memory.query.hybrid.enabled;
  const vectorEnabled = memory.provider !== "none" && memory.store.vector.enabled;
  if (!vectorEnabled) {
    return fullTextEnabled
      ? { status: "warn", detail: "full-text-only search configured" }
      : { status: "error", detail: "search unavailable" };
  }
  return fullTextEnabled
    ? { status: "ok", detail: "hybrid search configured" }
    : { status: "ok", detail: "vector search configured" };
}

export async function buildMemoryTapSnapshot(params: {
  cfg: OpenClawConfig;
  agentId: string;
  workspaceDir: string;
  request: MemoryTapSnapshotParams;
  nowMs?: number;
  searchHealth?: MemoryTapSearchHealth;
}): Promise<MemoryTapSnapshot> {
  const nowMs = params.nowMs ?? Date.now();
  const window: SnapshotWindow = {
    sinceMs: Date.parse(params.request.since),
    untilMs: Date.parse(params.request.until),
  };
  const filtered: SecretFilterCounter = { count: 0 };
  const selfIngestionFiltered: SelfIngestionFilterCounter = { count: 0 };
  const rawEvidenceFiltered: RawEvidenceFilterCounter = { count: 0 };
  const kinds = new Set(params.request.kinds);
  const dreaming = resolveMemoryDreamingConfig({
    cfg: params.cfg,
    pluginConfig: resolveMemoryDreamingPluginConfig(params.cfg),
  });
  const diary = await collectDiary({
    workspaceDir: params.workspaceDir,
    window,
    maxCandidates: params.request.maxCandidates,
    maxQuoteChars: params.request.maxQuoteChars,
    includeCandidates: kinds.has("dream"),
    filtered,
    selfIngestionFiltered,
    rawEvidenceFiltered,
  });
  const reports = await inspectDreamReports({
    cfg: params.cfg,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    window,
  });

  let evidenceCandidates: CollectedCandidate[] = [];
  let memoryCount = 0;
  let sessionCount = 0;
  let evidenceExamined = 0;
  let evidenceStoreReadable = true;
  try {
    const [entries, phaseHitCounts] = await Promise.all([
      readShortTermRecallEntries({
        workspaceDir: params.workspaceDir,
        nowMs,
      }),
      loadShortTermPromotionPhaseHitCounts({
        workspaceDir: params.workspaceDir,
        nowMs,
      }),
    ]);
    const evidence = collectEvidence({
      entries,
      window,
      maxQuoteChars: params.request.maxQuoteChars,
      kinds,
      phaseHitCounts,
      filtered,
      selfIngestionFiltered,
      rawEvidenceFiltered,
    });
    evidenceCandidates = evidence.candidates;
    memoryCount = evidence.memoryCount;
    sessionCount = evidence.sessionCount;
    evidenceExamined = evidence.examined;
  } catch {
    evidenceStoreReadable = false;
  }

  const allCandidates = dedupeCandidates([...diary.candidates, ...evidenceCandidates]).filter(
    (candidate) => kinds.has(candidate.kind),
  );
  const truncated = allCandidates.length > params.request.maxCandidates;
  const candidates = allCandidates.slice(0, params.request.maxCandidates).map((candidate) => {
    const { observedAtMs: _observedAtMs, recencyOrdinal: _recencyOrdinal, ...payload } = candidate;
    return payload;
  });
  const artifactFresh = diary.health.fresh || reports.fresh;
  const requiredArtifactDegraded =
    diary.health.status === "warn" || (reports.required && reports.status === "warn");
  const dreamingStatus: MemoryTapHealthStatus = !dreaming.enabled
    ? "error"
    : diary.health.status === "error" || reports.status === "error"
      ? "error"
      : requiredArtifactDegraded
        ? "warn"
        : "ok";
  const checks: MemoryTapHealthCheck[] = [
    { id: "gateway", status: "ok", detail: "authenticated read succeeded" },
    {
      id: "memory",
      status: evidenceStoreReadable ? (params.searchHealth?.status ?? "ok") : "error",
      detail: evidenceStoreReadable
        ? `readable; memory=${memoryCount}; sessions=${sessionCount}${params.searchHealth ? `; ${params.searchHealth.detail}` : ""}`
        : "evidence store unavailable",
    },
    {
      id: "dreaming",
      status: dreamingStatus,
      detail: dreaming.enabled
        ? `enabled; diary=${diary.health.detail}; reports=${reports.detail}`
        : "disabled",
    },
    {
      id: "cron",
      status:
        !dreaming.enabled || diary.health.status === "error"
          ? "error"
          : artifactFresh
            ? "ok"
            : "warn",
      detail: artifactFresh ? "fresh dream artifact observed" : "no fresh dream artifact observed",
    },
    {
      id: "artifact-provenance",
      status: rawEvidenceFiltered.count > 0 ? "warn" : "ok",
      detail:
        rawEvidenceFiltered.count > 0
          ? `filtered raw evidence=${rawEvidenceFiltered.count}`
          : candidates.length === 0
            ? "no eligible artifacts"
            : "virtual references verified",
    },
    {
      id: "self-ingestion",
      status: selfIngestionFiltered.count > 0 ? "warn" : "ok",
      detail: `filtered=${selfIngestionFiltered.count}`,
    },
    {
      id: "secrets",
      status: filtered.count > 0 ? "warn" : "ok",
      detail: `filtered=${filtered.count}`,
    },
  ];

  return {
    schemaVersion: 1,
    generatedAt: new Date(nowMs).toISOString(),
    agentId: params.agentId,
    window: {
      since: params.request.since,
      until: params.request.until,
    },
    health: {
      ok: checks.every((check) => check.status !== "error"),
      checks,
    },
    candidates,
    provenance: {
      candidateLimit: params.request.maxCandidates,
      quoteLimit: params.request.maxQuoteChars,
      examined: Math.min(100_000, diary.examined + evidenceExamined),
      truncated,
      filteredSecretCount: filtered.count,
    },
  };
}
