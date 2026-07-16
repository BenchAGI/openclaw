// Memory Tap wire-contract parsing keeps remote requests small, explicit, and bounded.
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_WINDOW_MS = 2 * DEFAULT_WINDOW_MS;
const DEFAULT_CANDIDATE_LIMIT = 25;
const MAX_CANDIDATE_LIMIT = 25;
const DEFAULT_QUOTE_LIMIT = 240;
export const MEMORY_TAP_MIN_QUOTE_CHARS = 40;
const MAX_QUOTE_LIMIT = 240;
const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/i;
const MEMORY_TAP_KINDS = ["dream", "memory", "session"] as const;
const ALLOWED_PARAM_KEYS = new Set(["since", "until", "kinds", "maxCandidates", "maxQuoteChars"]);

export type MemoryTapCandidateKind = (typeof MEMORY_TAP_KINDS)[number];

export type MemoryTapSnapshotParams = {
  since: string;
  until: string;
  kinds: MemoryTapCandidateKind[];
  maxCandidates: number;
  maxQuoteChars: number;
};

export type MemoryTapHealthStatus = "ok" | "warn" | "error";

export type MemoryTapHealthCheck = {
  id:
    | "gateway"
    | "memory"
    | "dreaming"
    | "cron"
    | "artifact-provenance"
    | "self-ingestion"
    | "secrets";
  status: MemoryTapHealthStatus;
  detail: string;
};

export type MemoryTapSnapshotCandidate = {
  id: string;
  kind: MemoryTapCandidateKind;
  excerpt: string;
  observedAt: string;
  signals: {
    recallCount: number;
    dailyCount: number;
    groundedCount: number;
    phaseHitCount: number;
  };
  provenance: {
    ref: string;
    digest: string;
  };
};

export type MemoryTapSnapshot = {
  schemaVersion: 1;
  generatedAt: string;
  agentId: string;
  window: {
    since: string;
    until: string;
  };
  health: {
    ok: boolean;
    checks: MemoryTapHealthCheck[];
  };
  candidates: MemoryTapSnapshotCandidate[];
  provenance: {
    candidateLimit: number;
    quoteLimit: number;
    examined: number;
    truncated: boolean;
    filteredSecretCount: number;
  };
};

export class MemoryTapInvalidRequestError extends Error {
  readonly code = "invalid_request";
}

function readTimestamp(value: unknown, key: "since" | "until", fallbackMs: number): number {
  if (value === undefined) {
    return fallbackMs;
  }
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value.trim())) {
    throw new MemoryTapInvalidRequestError(`${key} must be an ISO-8601 timestamp with an offset.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new MemoryTapInvalidRequestError(`${key} must be a valid timestamp.`);
  }
  return parsed;
}

function readBoundedInteger(params: {
  value: unknown;
  key: "maxCandidates" | "maxQuoteChars";
  fallback: number;
  min: number;
  max: number;
}): number {
  if (params.value === undefined) {
    return params.fallback;
  }
  if (typeof params.value !== "number" || !Number.isInteger(params.value)) {
    throw new MemoryTapInvalidRequestError(`${params.key} must be an integer.`);
  }
  return Math.max(params.min, Math.min(params.max, params.value));
}

function readKinds(value: unknown): MemoryTapCandidateKind[] {
  if (value === undefined) {
    return [...MEMORY_TAP_KINDS];
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > MEMORY_TAP_KINDS.length) {
    throw new MemoryTapInvalidRequestError("kinds must contain 1 to 3 supported values.");
  }
  const selected = new Set<MemoryTapCandidateKind>();
  for (const entry of value) {
    if (typeof entry !== "string" || !MEMORY_TAP_KINDS.includes(entry as MemoryTapCandidateKind)) {
      throw new MemoryTapInvalidRequestError("kinds contains an unsupported value.");
    }
    selected.add(entry as MemoryTapCandidateKind);
  }
  return MEMORY_TAP_KINDS.filter((kind) => selected.has(kind));
}

export function normalizeMemoryTapSnapshotParams(
  raw: unknown,
  nowMs = Date.now(),
): MemoryTapSnapshotParams {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new MemoryTapInvalidRequestError("params must be an object.");
  }
  const record = raw as Record<string, unknown>;
  const unsupported = Object.keys(record).filter((key) => !ALLOWED_PARAM_KEYS.has(key));
  if (unsupported.length > 0) {
    throw new MemoryTapInvalidRequestError("params contain an unsupported field.");
  }
  const untilMs = readTimestamp(record.until, "until", nowMs);
  if (untilMs > nowMs) {
    throw new MemoryTapInvalidRequestError("until cannot be later than the snapshot time.");
  }
  const sinceMs = readTimestamp(record.since, "since", untilMs - DEFAULT_WINDOW_MS);
  if (sinceMs >= untilMs) {
    throw new MemoryTapInvalidRequestError("since must be earlier than until.");
  }
  if (untilMs - sinceMs > MAX_WINDOW_MS) {
    throw new MemoryTapInvalidRequestError("snapshot windows cannot exceed 48 hours.");
  }
  return {
    since: new Date(sinceMs).toISOString(),
    until: new Date(untilMs).toISOString(),
    kinds: readKinds(record.kinds),
    maxCandidates: readBoundedInteger({
      value: record.maxCandidates,
      key: "maxCandidates",
      fallback: DEFAULT_CANDIDATE_LIMIT,
      min: 1,
      max: MAX_CANDIDATE_LIMIT,
    }),
    maxQuoteChars: readBoundedInteger({
      value: record.maxQuoteChars,
      key: "maxQuoteChars",
      fallback: DEFAULT_QUOTE_LIMIT,
      min: MEMORY_TAP_MIN_QUOTE_CHARS,
      max: MAX_QUOTE_LIMIT,
    }),
  };
}
