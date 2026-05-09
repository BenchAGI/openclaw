import { loadConfig } from "../config/config.js";
import {
  loadSessionStore,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionStoreEntry,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import {
  emitAgentEvent,
  registerAgentEventListener,
  type AgentEventPayload,
} from "../infra/agent-events.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { onSessionLifecycleEvent, type SessionLifecycleEvent } from "./session-lifecycle-events.js";

type SessionBookendKind = "opened" | "closed";

export type SessionObservabilityStats = {
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
  aborted?: boolean;
  stopReason?: string;
  error?: string;
  status?: SessionEntry["status"];
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  estimatedCostUsd?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

export type SessionObservabilitySnapshot = {
  sessionId?: string;
  transcriptPath?: string;
  agentId?: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
  stats?: SessionObservabilityStats;
};

export type SessionObservabilityBookendDeps = {
  onSessionLifecycleEvent?: typeof onSessionLifecycleEvent;
  registerAgentEventListener?: typeof registerAgentEventListener;
  emitAgentEvent?: typeof emitAgentEvent;
  resolveSessionSnapshot?: (event: SessionLifecycleEvent) => SessionObservabilitySnapshot;
  onError?: (error: unknown) => void;
};

export type SessionObservabilityBookend = {
  stop: () => void;
};

type ActiveBookendState = {
  bookend: SessionObservabilityBookend | null;
};

const activeBookendState: ActiveBookendState = {
  bookend: null,
};

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function collectSessionEntryStats(entry?: SessionEntry): SessionObservabilityStats | undefined {
  if (!entry) {
    return undefined;
  }
  const stats: SessionObservabilityStats = {};
  const copyNumber = (key: keyof SessionObservabilityStats, value: unknown) => {
    const normalized = readFiniteNumber(value);
    if (normalized !== undefined) {
      stats[key] = normalized as never;
    }
  };
  copyNumber("startedAt", entry.startedAt);
  copyNumber("endedAt", entry.endedAt);
  copyNumber("durationMs", entry.runtimeMs);
  copyNumber("inputTokens", entry.inputTokens);
  copyNumber("outputTokens", entry.outputTokens);
  copyNumber("totalTokens", entry.totalTokens);
  copyNumber("estimatedCostUsd", entry.estimatedCostUsd);
  copyNumber("cacheRead", entry.cacheRead);
  copyNumber("cacheWrite", entry.cacheWrite);
  if (entry.status) {
    stats.status = entry.status;
  }
  return Object.keys(stats).length > 0 ? stats : undefined;
}

function resolveDefaultSessionSnapshot(event: SessionLifecycleEvent): SessionObservabilitySnapshot {
  const sessionKey = normalizeOptionalString(event.sessionKey);
  if (!sessionKey) {
    return {};
  }

  try {
    const cfg = loadConfig();
    const agentId = resolveAgentIdFromSessionKey(sessionKey);
    const storePath = resolveStorePath(cfg.session?.store, { agentId });
    const store = loadSessionStore(storePath);
    const resolved = resolveSessionStoreEntry({ store, sessionKey });
    const entry = resolved.existing;
    const transcriptPath = entry
      ? resolveSessionFilePath(
          entry.sessionId,
          entry,
          resolveSessionFilePathOptions({ agentId, storePath }),
        )
      : undefined;
    return {
      sessionId: entry?.sessionId,
      transcriptPath,
      agentId,
      parentSessionKey: entry?.parentSessionKey ?? entry?.spawnedBy ?? event.parentSessionKey,
      label: entry?.label ?? event.label,
      displayName: entry?.displayName ?? event.displayName,
      stats: collectSessionEntryStats(entry),
    };
  } catch {
    return {};
  }
}

function resolveLifecycleEventKind(
  event: SessionLifecycleEvent,
  snapshot: SessionObservabilitySnapshot,
): SessionBookendKind | null {
  const reason = event.reason.trim();
  if (reason === "create" || reason === "created" || reason === "new") {
    return "opened";
  }
  if (
    reason === "close" ||
    reason === "closed" ||
    reason === "delete" ||
    reason === "deleted" ||
    reason === "session-delete"
  ) {
    return "closed";
  }
  if (reason === "subagent-status") {
    const status = snapshot.stats?.status;
    return status === "done" || status === "failed" || status === "killed" || status === "timeout"
      ? "closed"
      : null;
  }
  return null;
}

function resolveAgentLifecycleEventKind(event: AgentEventPayload): SessionBookendKind | null {
  if (event.stream !== "lifecycle") {
    return null;
  }
  const phase = normalizeOptionalString(event.data.phase);
  if (phase === "start") {
    return "opened";
  }
  if (phase === "end" || phase === "error") {
    return "closed";
  }
  return null;
}

function collectAgentLifecycleStats(event: AgentEventPayload): SessionObservabilityStats {
  const startedAt = readFiniteNumber(event.data.startedAt);
  const endedAt = readFiniteNumber(event.data.endedAt);
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(startedAt !== undefined && endedAt !== undefined
      ? { durationMs: Math.max(0, endedAt - startedAt) }
      : {}),
    ...(readBoolean(event.data.aborted) !== undefined
      ? { aborted: readBoolean(event.data.aborted) }
      : {}),
    ...(normalizeOptionalString(event.data.stopReason)
      ? { stopReason: normalizeOptionalString(event.data.stopReason) }
      : {}),
    ...(normalizeOptionalString(event.data.error)
      ? { error: normalizeOptionalString(event.data.error) }
      : {}),
  };
}

function mergeStats(
  snapshotStats: SessionObservabilityStats | undefined,
  eventStats: SessionObservabilityStats | undefined,
): SessionObservabilityStats {
  return {
    ...snapshotStats,
    ...eventStats,
  };
}

function emitBookend(params: {
  kind: SessionBookendKind;
  runId: string;
  sessionKey: string;
  reason: string;
  snapshot: SessionObservabilitySnapshot;
  eventStats?: SessionObservabilityStats;
  emit: typeof emitAgentEvent;
}): void {
  const stats = mergeStats(params.snapshot.stats, params.eventStats);
  params.emit({
    runId: params.runId,
    stream: `agent.session.${params.kind}`,
    sessionKey: params.sessionKey,
    data: {
      sessionKey: params.sessionKey,
      reason: params.reason,
      transcriptPath: params.snapshot.transcriptPath ?? null,
      stats,
      ...(params.snapshot.sessionId ? { sessionId: params.snapshot.sessionId } : {}),
      ...(params.snapshot.agentId ? { agentId: params.snapshot.agentId } : {}),
      ...(params.snapshot.parentSessionKey
        ? { parentSessionKey: params.snapshot.parentSessionKey }
        : {}),
      ...(params.snapshot.label ? { label: params.snapshot.label } : {}),
      ...(params.snapshot.displayName ? { displayName: params.snapshot.displayName } : {}),
    },
  });
}

function reportError(deps: SessionObservabilityBookendDeps, error: unknown): void {
  if (deps.onError) {
    deps.onError(error);
    return;
  }
  if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
    return;
  }
  console.warn(`[openclaw] session observability bookend: ${formatErrorMessage(error)}`);
}

export function createSessionObservabilityBookend(
  deps: SessionObservabilityBookendDeps = {},
): SessionObservabilityBookend {
  const subscribeSessionLifecycle = deps.onSessionLifecycleEvent ?? onSessionLifecycleEvent;
  const subscribeAgentEvents = deps.registerAgentEventListener ?? registerAgentEventListener;
  const emit = deps.emitAgentEvent ?? emitAgentEvent;
  const resolveSessionSnapshot = deps.resolveSessionSnapshot ?? resolveDefaultSessionSnapshot;

  const sessionLifecycleStop = subscribeSessionLifecycle((event) => {
    try {
      const sessionKey = normalizeOptionalString(event.sessionKey);
      if (!sessionKey) {
        return;
      }
      const snapshot = resolveSessionSnapshot(event);
      const kind = resolveLifecycleEventKind(event, snapshot);
      if (!kind) {
        return;
      }
      emitBookend({
        kind,
        runId: sessionKey,
        sessionKey,
        reason: event.reason,
        snapshot: {
          ...snapshot,
          parentSessionKey: snapshot.parentSessionKey ?? event.parentSessionKey,
          label: snapshot.label ?? event.label,
          displayName: snapshot.displayName ?? event.displayName,
        },
        emit,
      });
    } catch (error) {
      reportError(deps, error);
    }
  });

  const agentEventStop = subscribeAgentEvents((event) => {
    try {
      const kind = resolveAgentLifecycleEventKind(event);
      if (!kind) {
        return;
      }
      const sessionKey = normalizeOptionalString(event.sessionKey) ?? event.runId;
      const lifecycleEvent: SessionLifecycleEvent = {
        sessionKey,
        reason: kind === "opened" ? "agent-lifecycle-start" : "agent-lifecycle-close",
      };
      emitBookend({
        kind,
        runId: event.runId,
        sessionKey,
        reason: lifecycleEvent.reason,
        snapshot: resolveSessionSnapshot(lifecycleEvent),
        eventStats: collectAgentLifecycleStats(event),
        emit,
      });
    } catch (error) {
      reportError(deps, error);
    }
  });

  return {
    stop: () => {
      sessionLifecycleStop();
      agentEventStop();
    },
  };
}

export function startSessionObservabilityBookend(
  deps: SessionObservabilityBookendDeps = {},
): SessionObservabilityBookend {
  if (activeBookendState.bookend) {
    return activeBookendState.bookend;
  }
  activeBookendState.bookend = createSessionObservabilityBookend(deps);
  return activeBookendState.bookend;
}

export function resetSessionObservabilityBookendForTest(): void {
  activeBookendState.bookend?.stop();
  activeBookendState.bookend = null;
}
