import { describe, expect, it } from "vitest";
import { createEventFrameHistory } from "./event-frame-history.js";

describe("event-frame history", () => {
  it("records chat frames by sessionKey and replays since seq", () => {
    const history = createEventFrameHistory({ maxPerSession: 10 });
    history.record({
      type: "event",
      event: "chat",
      seq: 1,
      payload: { sessionKey: "agent:aurelius", runId: "run-1", state: "delta" },
    });
    history.record({
      type: "event",
      event: "chat",
      seq: 2,
      payload: { sessionKey: "agent:aurelius", runId: "run-1", state: "final" },
    });

    expect(history.get("agent:aurelius", 1).map((frame) => frame.seq)).toEqual([2]);
  });

  it("records agent lifecycle frames with data.sessionKey", () => {
    const history = createEventFrameHistory();
    history.record({
      type: "event",
      event: "agent",
      seq: 7,
      payload: {
        runId: "run-1",
        seq: 1,
        stream: "lifecycle",
        ts: Date.now(),
        data: { sessionKey: "agent:aurelius", phase: "end" },
      },
    });

    expect(history.get("agent:aurelius", 0)).toHaveLength(1);
  });

  it("keeps only the bounded per-session window", () => {
    const history = createEventFrameHistory({ maxPerSession: 2 });
    for (let seq = 1; seq <= 3; seq++) {
      history.record({
        type: "event",
        event: "chat",
        seq,
        payload: { sessionKey: "agent:aurelius", runId: "run-1", state: "delta" },
      });
    }

    expect(history.get("agent:aurelius").map((frame) => frame.seq)).toEqual([2, 3]);
  });
});
