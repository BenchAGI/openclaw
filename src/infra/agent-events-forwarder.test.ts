import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentEventsBatchRequest,
  buildBenchAgentEvent,
  createAgentEventsForwarder,
  resetAgentEventsForwarderForTest,
  type AgentEventsBatchRequest,
  type AgentEventsForwarderConfig,
} from "./agent-events-forwarder.js";
import type { AgentEventPayload } from "./agent-events.js";

const config: AgentEventsForwarderConfig = {
  enabled: true,
  endpoint: "https://benchagi.example.test/api/v1/agent/events",
  tenantApiKey: "tenant-key",
  agentId: "aurelius",
  hostId: "host-1",
};

function makeEvent(overrides: Partial<AgentEventPayload> = {}): AgentEventPayload {
  return {
    runId: "run-1",
    seq: 1,
    stream: "tool",
    ts: 1_000,
    data: { name: "Bash" },
    sessionKey: "agent:main:main",
    ...overrides,
  };
}

function createSendBatchMock() {
  return vi.fn(async (_request: AgentEventsBatchRequest) => undefined);
}

describe("agent events forwarder", () => {
  beforeEach(() => {
    resetAgentEventsForwarderForTest();
  });

  it("maps agent stream events to BenchAGI event records", () => {
    expect(buildBenchAgentEvent(makeEvent(), config)).toMatchObject({
      type: "agent.stream.tool",
      runId: "run-1",
      seq: 1,
      ts: 1_000,
      stream: "tool",
      agentId: "aurelius",
      hostId: "host-1",
      sessionKey: "agent:main:main",
      sessionId: "agent:main:main",
      schemaVersion: 1,
    });
  });

  it("preserves explicit synthetic agent event types", () => {
    expect(
      buildBenchAgentEvent(
        makeEvent({
          stream: "agent.session.closed",
          data: { sessionId: "session-1", agentId: "cole" },
        }),
        config,
      ),
    ).toMatchObject({
      type: "agent.session.closed",
      sessionId: "session-1",
      agentId: "cole",
    });
  });

  it("skips streams outside the Phase 1 allowlist", () => {
    expect(buildBenchAgentEvent(makeEvent({ stream: "debug-noise" }), config)).toBeNull();
  });

  it("builds the authenticated batch request", () => {
    const event = buildBenchAgentEvent(makeEvent(), config);
    expect(event).not.toBeNull();
    const request = buildAgentEventsBatchRequest(config, [event!]);

    expect(request).toEqual({
      endpoint: config.endpoint,
      headers: {
        authorization: "Bearer tenant-key",
        "content-type": "application/json",
      },
      body: {
        events: [event],
      },
    });
  });

  it("flushes queued events through the registered listener", async () => {
    let listener: ((evt: AgentEventPayload) => void) | undefined;
    const unsubscribe = vi.fn();
    const sendBatch = createSendBatchMock();
    const forwarder = createAgentEventsForwarder({
      config,
      registerAgentEventListener: (next) => {
        listener = next;
        return unsubscribe;
      },
      sendBatch,
    });

    expect(forwarder).not.toBeNull();
    listener?.(makeEvent());
    expect(forwarder?.getPendingCount()).toBe(1);

    await forwarder?.flush();

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const request = sendBatch.mock.calls[0]?.[0];
    if (!request) {
      throw new Error("expected batch request");
    }
    expect(request.body.events).toHaveLength(1);
    expect(forwarder?.getPendingCount()).toBe(0);

    forwarder?.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("flushes immediately when the batch reaches the size limit", async () => {
    let listener: ((evt: AgentEventPayload) => void) | undefined;
    const sendBatch = createSendBatchMock();
    const forwarder = createAgentEventsForwarder({
      config: { ...config, maxBatchSize: 2 },
      registerAgentEventListener: (next) => {
        listener = next;
        return () => undefined;
      },
      sendBatch,
    });

    listener?.(makeEvent({ seq: 1 }));
    listener?.(makeEvent({ seq: 2 }));
    await forwarder?.flush();

    expect(sendBatch).toHaveBeenCalledTimes(1);
    const request = sendBatch.mock.calls[0]?.[0];
    if (!request) {
      throw new Error("expected batch request");
    }
    expect(request.body.events.map((event) => event.seq)).toEqual([1, 2]);
  });

  it("keeps the scheduled flush timer referenced for short CLI runs", () => {
    let listener: ((evt: AgentEventPayload) => void) | undefined;
    const unref = vi.fn();
    const setTimer = vi.fn(
      (_cb: () => void, _ms?: number) => ({ unref }) as unknown as ReturnType<typeof setTimeout>,
    );
    const forwarder = createAgentEventsForwarder({
      config,
      registerAgentEventListener: (next) => {
        listener = next;
        return () => undefined;
      },
      sendBatch: createSendBatchMock(),
      setTimeout: setTimer as unknown as typeof setTimeout,
    });

    listener?.(makeEvent());

    expect(forwarder).not.toBeNull();
    expect(setTimer).toHaveBeenCalledTimes(1);
    expect(unref).not.toHaveBeenCalled();

    forwarder?.stop();
  });

  it("bounds endpoint backlog by dropping the oldest queued events", async () => {
    let listener: ((evt: AgentEventPayload) => void) | undefined;
    let releaseFirstBatch: (() => void) | undefined;
    const firstBatch = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    const sendBatch = vi.fn(async (_request: AgentEventsBatchRequest) => {
      if (sendBatch.mock.calls.length === 1) {
        await firstBatch;
      }
    });
    const forwarder = createAgentEventsForwarder({
      config: { ...config, maxBatchSize: 2, maxQueueSize: 3 },
      registerAgentEventListener: (next) => {
        listener = next;
        return () => undefined;
      },
      sendBatch,
    });

    listener?.(makeEvent({ seq: 1 }));
    listener?.(makeEvent({ seq: 2 }));
    listener?.(makeEvent({ seq: 3 }));
    listener?.(makeEvent({ seq: 4 }));
    listener?.(makeEvent({ seq: 5 }));
    listener?.(makeEvent({ seq: 6 }));

    expect(forwarder?.getPendingCount()).toBe(3);

    releaseFirstBatch?.();
    await forwarder?.flush();

    expect(
      sendBatch.mock.calls.map(([request]) => request.body.events.map((event) => event.seq)),
    ).toEqual([[1, 2], [4, 5], [6]]);
  });
});
