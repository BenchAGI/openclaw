import type { EventFrame } from "./protocol/index.js";

export type EventFrameHistory = {
  record(frame: EventFrame): void;
  get(sessionKey: string, sinceSeq?: number): EventFrame[];
};

const RECORDABLE_EVENTS = new Set(["chat", "chat.side_result", "agent", "session.tool"]);

function payloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function sessionKeyFromPayload(event: string, payload: unknown): string | null {
  const record = payloadRecord(payload);
  if (!record) {
    return null;
  }
  if (typeof record.sessionKey === "string" && record.sessionKey.length > 0) {
    return record.sessionKey;
  }
  if (event === "agent") {
    const data = payloadRecord(record.data);
    if (typeof data?.sessionKey === "string" && data.sessionKey.length > 0) {
      return data.sessionKey;
    }
  }
  return null;
}

export function createEventFrameHistory(params?: {
  maxPerSession?: number;
}): EventFrameHistory {
  const maxPerSession = Math.max(1, params?.maxPerSession ?? 1000);
  const bySession = new Map<string, EventFrame[]>();

  return {
    record(frame) {
      if (!RECORDABLE_EVENTS.has(frame.event) || typeof frame.seq !== "number") {
        return;
      }
      const sessionKey = sessionKeyFromPayload(frame.event, frame.payload);
      if (!sessionKey) {
        return;
      }
      const bucket = bySession.get(sessionKey) ?? [];
      bucket.push(frame);
      if (bucket.length > maxPerSession) {
        bucket.splice(0, bucket.length - maxPerSession);
      }
      bySession.set(sessionKey, bucket);
    },
    get(sessionKey, sinceSeq) {
      const bucket = bySession.get(sessionKey) ?? [];
      if (typeof sinceSeq !== "number") {
        return [...bucket];
      }
      return bucket.filter((frame) => typeof frame.seq === "number" && frame.seq > sinceSeq);
    },
  };
}

export const __testing = {
  sessionKeyFromPayload,
};
