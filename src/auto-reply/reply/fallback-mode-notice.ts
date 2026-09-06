/** Builds the persistent in-text banner for replies won by a fallback provider. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  getReplyPayloadMetadata,
  isReplyPayloadStatusNotice,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { ReplyPayload } from "../types.js";

export type FallbackModeAttempt = {
  provider: string;
  model: string;
  result: string;
  reason?: string;
  status?: number;
};

export type FallbackModeExecutionTrace = {
  winnerProvider?: string;
  winnerModel?: string;
  attempts?: FallbackModeAttempt[];
  fallbackUsed?: boolean;
};

function formatLastFailureReason(
  attempts: FallbackModeAttempt[] | undefined,
  fallbackReason: string | undefined,
): string {
  const failures = (attempts ?? []).filter((attempt) => attempt.result !== "success");
  const last = failures[failures.length - 1];
  const reason = normalizeOptionalString(last?.reason ?? fallbackReason);
  if (reason) {
    return reason.replace(/_/g, " ");
  }
  if (!last) {
    return "primary model unavailable";
  }
  if (typeof last.status === "number") {
    return `HTTP ${last.status}`;
  }
  return last.result.replace(/_/g, " ");
}

/**
 * Merges the runner-level execution trace with the reply-level fallback attempts so the
 * banner sees the full provider journey of this turn. Re-homed from the monolithic
 * runner's `mergeExecutionTrace` when upstream split the reply pipeline (2026.9.2).
 */
export function mergeFallbackModeExecutionTrace(params: {
  executionTrace?: FallbackModeExecutionTrace;
  fallbackAttempts?: ReadonlyArray<{
    provider: string;
    model: string;
    reason?: string;
    status?: number;
  }>;
  provider?: string;
  model?: string;
  exhausted?: boolean;
}): FallbackModeExecutionTrace | undefined {
  const executionAttempts = params.exhausted
    ? (params.executionTrace?.attempts ?? []).filter((attempt) => attempt.result !== "success")
    : (params.executionTrace?.attempts ?? []);
  const attempts: FallbackModeAttempt[] = [
    ...(params.fallbackAttempts ?? []).map((attempt) => {
      const entry: FallbackModeAttempt = {
        provider: attempt.provider,
        model: attempt.model,
        result: "error",
      };
      if (attempt.reason) {
        entry.reason = attempt.reason;
      }
      if (typeof attempt.status === "number") {
        entry.status = attempt.status;
      }
      return entry;
    }),
    ...executionAttempts,
  ];
  const winnerProvider = params.exhausted
    ? undefined
    : (params.executionTrace?.winnerProvider ?? normalizeOptionalString(params.provider));
  const winnerModel = params.exhausted
    ? undefined
    : (params.executionTrace?.winnerModel ?? normalizeOptionalString(params.model));
  if (
    winnerProvider &&
    winnerModel &&
    !attempts.some(
      (attempt) =>
        attempt.provider === winnerProvider &&
        attempt.model === winnerModel &&
        attempt.result === "success",
    )
  ) {
    attempts.push({ provider: winnerProvider, model: winnerModel, result: "success" });
  }
  if (attempts.length === 0 && !winnerProvider) {
    return params.executionTrace;
  }
  return {
    ...params.executionTrace,
    ...(winnerProvider ? { winnerProvider } : {}),
    ...(winnerModel ? { winnerModel } : {}),
    attempts,
    fallbackUsed:
      params.executionTrace?.fallbackUsed ?? (params.fallbackAttempts?.length ?? 0) > 0,
  };
}

/**
 * Builds the standard fallback-mode banner shown whenever a reply was produced by a
 * fallback provider instead of the requested primary:
 * `⚠ running in fallback mode (<provider>/<model> — <last failure reason>)`.
 *
 * Unlike the transition-only fallback notice payloads, this fires on every reply won
 * by a non-primary provider. Returns undefined when the primary answered, when the
 * winner is unknown, or when fallback merely switched models within the same provider.
 */
export function buildFallbackModeNotice(params: {
  executionTrace: FallbackModeExecutionTrace | undefined;
  requestedProvider: string | undefined;
  fallbackActive?: boolean;
  fallbackReason?: string;
}): string | undefined {
  const trace = params.executionTrace;
  const fallbackActive = params.fallbackActive ?? trace?.fallbackUsed === true;
  if (!fallbackActive) {
    return undefined;
  }
  const winnerProvider = normalizeOptionalString(trace?.winnerProvider);
  const requestedProvider = normalizeOptionalString(params.requestedProvider);
  if (!winnerProvider || !requestedProvider) {
    return undefined;
  }
  if (winnerProvider.toLowerCase() === requestedProvider.toLowerCase()) {
    return undefined;
  }
  const winnerModel = normalizeOptionalString(trace?.winnerModel);
  const winnerRef = winnerModel ? `${winnerProvider}/${winnerModel}` : winnerProvider;
  return `⚠ running in fallback mode (${winnerRef} — ${formatLastFailureReason(trace?.attempts, params.fallbackReason)})`;
}

/** Prepends the fallback-mode banner to the first visible answer payload, preserving metadata. */
export function prependFallbackModeNotice(
  payloads: ReplyPayload[],
  notice: string,
): ReplyPayload[] {
  const index = payloads.findIndex(
    (payload) =>
      !isReplyPayloadStatusNotice(payload) &&
      !payload.isReasoning &&
      typeof payload.text === "string" &&
      payload.text.trim().length > 0 &&
      payload.text.trim() !== SILENT_REPLY_TOKEN,
  );
  if (index === -1) {
    return payloads;
  }
  const existing = payloads[index];
  if (!existing) {
    return payloads;
  }
  const next = {
    ...existing,
    text: `${notice}\n\n${existing.text ?? ""}`,
  };
  const metadata = getReplyPayloadMetadata(existing);
  // Transcript mirrors must track the mutated text or source-reply delivery drifts.
  const nextWithMetadata = metadata
    ? setReplyPayloadMetadata(next, {
        ...metadata,
        ...(metadata.sourceReplyTranscriptMirror
          ? {
              sourceReplyTranscriptMirror: {
                ...metadata.sourceReplyTranscriptMirror,
                text: next.text,
              },
            }
          : {}),
      })
    : next;
  const updated = payloads.slice();
  updated[index] = nextWithMetadata;
  return updated;
}
