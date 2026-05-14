import type { SessionEntry } from "../config/sessions.js";

export type SessionLifecycleStats = {
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

export type SessionLifecycleEvent = {
  sessionKey: string;
  reason: string;
  parentSessionKey?: string;
  label?: string;
  displayName?: string;
  stats?: SessionLifecycleStats;
};

type SessionLifecycleListener = (event: SessionLifecycleEvent) => void;

const SESSION_LIFECYCLE_LISTENERS = new Set<SessionLifecycleListener>();

export function onSessionLifecycleEvent(listener: SessionLifecycleListener): () => void {
  SESSION_LIFECYCLE_LISTENERS.add(listener);
  return () => {
    SESSION_LIFECYCLE_LISTENERS.delete(listener);
  };
}

export function emitSessionLifecycleEvent(event: SessionLifecycleEvent): void {
  for (const listener of SESSION_LIFECYCLE_LISTENERS) {
    try {
      listener(event);
    } catch {
      // Best-effort, do not propagate listener errors.
    }
  }
}
