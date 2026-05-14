import { describe, expect, it, vi } from "vitest";
import type { AgentEventPayload } from "../infra/agent-events.js";
import type { SessionLifecycleEvent } from "./session-lifecycle-events.js";
import { createSessionObservabilityBookend } from "./session-observability-bookend.js";

function createHarness() {
  let sessionListener: ((event: SessionLifecycleEvent) => void) | undefined;
  let agentListener: ((event: AgentEventPayload) => void) | undefined;
  const emitAgentEvent = vi.fn();
  const stopSession = vi.fn();
  const stopAgent = vi.fn();
  const bookend = createSessionObservabilityBookend({
    onSessionLifecycleEvent: (listener) => {
      sessionListener = listener;
      return stopSession;
    },
    registerAgentEventListener: (listener) => {
      agentListener = listener;
      return stopAgent;
    },
    emitAgentEvent,
    resolveSessionSnapshot: () => ({
      sessionId: "session-1",
      transcriptPath: "/tmp/session-1.jsonl",
      agentId: "aurelius",
      stats: { totalTokens: 42 },
    }),
  });
  return { bookend, emitAgentEvent, sessionListener, agentListener, stopSession, stopAgent };
}

describe("session observability bookend", () => {
  it("emits a synthetic session opened event from session lifecycle create", () => {
    const harness = createHarness();

    harness.sessionListener?.({
      sessionKey: "agent:main:main",
      reason: "create",
      label: "Main",
    });

    expect(harness.emitAgentEvent).toHaveBeenCalledWith({
      runId: "agent:main:main",
      stream: "agent.session.opened",
      sessionKey: "agent:main:main",
      data: expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        reason: "create",
        transcriptPath: "/tmp/session-1.jsonl",
        agentId: "aurelius",
        label: "Main",
        stats: { totalTokens: 42 },
      }),
    });
  });

  it("emits a synthetic session closed event from session lifecycle close", () => {
    const harness = createHarness();

    harness.sessionListener?.({
      sessionKey: "agent:main:main",
      reason: "close",
      stats: {
        startedAt: 100,
        endedAt: 250,
        durationMs: 150,
        status: "done",
        outputTokens: 10,
      },
    });

    expect(harness.emitAgentEvent).toHaveBeenCalledWith({
      runId: "agent:main:main",
      stream: "agent.session.closed",
      sessionKey: "agent:main:main",
      data: expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        reason: "close",
        transcriptPath: "/tmp/session-1.jsonl",
        stats: expect.objectContaining({
          totalTokens: 42,
          startedAt: 100,
          endedAt: 250,
          durationMs: 150,
          status: "done",
          outputTokens: 10,
        }),
      }),
    });
  });

  it("emits a synthetic session opened event from agent lifecycle start", () => {
    const harness = createHarness();

    harness.agentListener?.({
      runId: "run-1",
      seq: 7,
      stream: "lifecycle",
      ts: 1_000,
      sessionKey: "agent:main:main",
      data: {
        phase: "start",
        startedAt: 100,
      },
    });

    expect(harness.emitAgentEvent).toHaveBeenCalledWith({
      runId: "run-1",
      stream: "agent.session.opened",
      sessionKey: "agent:main:main",
      data: expect.objectContaining({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
        reason: "agent-lifecycle-start",
        transcriptPath: "/tmp/session-1.jsonl",
        stats: expect.objectContaining({
          totalTokens: 42,
          startedAt: 100,
        }),
      }),
    });
  });

  it("does not emit a close bookend directly from agent lifecycle end", () => {
    const harness = createHarness();

    harness.agentListener?.({
      runId: "run-1",
      seq: 7,
      stream: "lifecycle",
      ts: 1_000,
      sessionKey: "agent:main:main",
      data: {
        phase: "end",
        startedAt: 100,
        endedAt: 250,
      },
    });

    expect(harness.emitAgentEvent).not.toHaveBeenCalled();
  });

  it("unsubscribes both listeners on stop", () => {
    const harness = createHarness();

    harness.bookend.stop();

    expect(harness.stopSession).toHaveBeenCalledTimes(1);
    expect(harness.stopAgent).toHaveBeenCalledTimes(1);
  });
});
