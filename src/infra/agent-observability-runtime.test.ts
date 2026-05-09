import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type {
  AgentEventsBatchRequest,
  AgentEventsForwarderConfig,
} from "./agent-events-forwarder.js";
import type { AgentEventPayload } from "./agent-events.js";
import {
  resetAgentObservabilityRuntimeForTest,
  startAgentObservabilityRuntime,
  stopAgentObservabilityRuntime,
} from "./agent-observability-runtime.js";

const config: AgentEventsForwarderConfig = {
  enabled: true,
  endpoint: "https://benchagi.example.test/api/v1/agent/events",
  tenantApiKey: "tenant-key",
  agentId: "aurelius",
  hostId: "host-1",
};

describe("agent observability runtime", () => {
  beforeEach(async () => {
    await resetAgentObservabilityRuntimeForTest();
  });

  it("does not start the bookend when the forwarder is disabled", () => {
    const onSessionLifecycleEvent = vi.fn(
      (_listener: (event: SessionLifecycleEvent) => void) => () => undefined,
    );

    const runtime = startAgentObservabilityRuntime({
      forwarder: {
        config: null,
      },
      bookend: {
        onSessionLifecycleEvent,
      },
    });

    expect(runtime).toBeNull();
    expect(onSessionLifecycleEvent).not.toHaveBeenCalled();
  });

  it("starts the forwarder before the bookend and flushes on stop", async () => {
    const order: string[] = [];
    let agentListener: ((event: AgentEventPayload) => void) | undefined;
    let sessionListener: ((event: SessionLifecycleEvent) => void) | undefined;
    const sendBatch = vi.fn(async (_request: AgentEventsBatchRequest) => undefined);

    const runtime = startAgentObservabilityRuntime({
      forwarder: {
        config,
        registerAgentEventListener: (listener) => {
          order.push("forwarder");
          agentListener = listener;
          return () => undefined;
        },
        sendBatch,
      },
      bookend: {
        onSessionLifecycleEvent: (listener) => {
          order.push("bookend");
          sessionListener = listener;
          return () => undefined;
        },
        registerAgentEventListener: () => () => undefined,
        resolveSessionSnapshot: () => ({ sessionId: "session-1" }),
      },
    });

    expect(runtime).not.toBeNull();
    expect(order).toEqual(["forwarder", "bookend"]);

    sessionListener?.({
      sessionKey: "agent:main:main",
      reason: "close",
      stats: { status: "done" },
    });
    agentListener?.({
      runId: "run-1",
      seq: 1,
      stream: "tool",
      ts: 1_000,
      data: { name: "Bash" },
      sessionKey: "agent:main:main",
    });

    await stopAgentObservabilityRuntime();

    expect(sendBatch).toHaveBeenCalled();
  });
});
