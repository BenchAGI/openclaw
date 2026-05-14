import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assistantMessageImFixture,
  assistantThreadContextChangedFixture,
  assistantThreadStartedFixture,
} from "../../__tests__/fixtures/assistant-events.js";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { getAssistantSurfaceMetadata, type SlackMonitorContext } from "../context.js";
import type { SlackMessageHandler } from "../message-handler.js";
import { registerSlackAssistantEvents } from "./assistant.js";
import { registerSlackMessageEvents } from "./messages.js";

type RegisteredHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

type TestHarness = {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  handlers: Map<string, RegisteredHandler[]>;
  loggerInfo: ReturnType<typeof vi.fn>;
  markMessageSeen: ReturnType<typeof vi.fn>;
  trackEvent: () => void;
  trackEventMock: ReturnType<typeof vi.fn>;
};

function makeAccount(params?: {
  bridgeEnabled?: boolean;
  policy?: "inherit" | "dm" | "channel" | "disabled";
}): ResolvedSlackAccount {
  return {
    accountId: "bench-aurelius",
    enabled: true,
    botTokenSource: "config",
    appTokenSource: "config",
    userTokenSource: "none",
    config: {
      agentKitBridge: {
        enabled: params?.bridgeEnabled ?? false,
        url: params?.bridgeEnabled ? "http://127.0.0.1:8717" : "",
        timeoutMs: 60000,
        mode: "runtime-adapter",
        policy: params?.policy,
      },
    },
  } as ResolvedSlackAccount;
}

function createHarness(params?: {
  bridgeEnabled?: boolean;
  policy?: "inherit" | "dm" | "channel" | "disabled";
  shouldDrop?: (body: unknown) => boolean;
}): TestHarness {
  const handlers = new Map<string, RegisteredHandler[]>();
  const seen = new Set<string>();
  const loggerInfo = vi.fn();
  const markMessageSeen = vi.fn((channelId: string | undefined, ts?: string) => {
    if (!channelId || !ts) {
      return false;
    }
    const key = `${channelId}:${ts}`;
    const wasSeen = seen.has(key);
    seen.add(key);
    return wasSeen;
  });
  const trackEventMock = vi.fn();
  const trackEvent = () => {
    trackEventMock();
  };
  const app = {
    event: (name: string, handler: RegisteredHandler) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
  };

  const ctx = {
    app,
    cfg: {},
    accountId: "bench-aurelius",
    botToken: "xoxb-test",
    runtime: { error: vi.fn() },
    botUserId: "U_BOT",
    teamId: "T123ABC456",
    apiAppId: "A123ABC456",
    logger: {
      info: loggerInfo,
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
    markMessageSeen,
    releaseSeenMessage: (channelId: string | undefined, ts?: string) => {
      if (channelId && ts) {
        seen.delete(`${channelId}:${ts}`);
      }
    },
    shouldDropMismatchedSlackEvent:
      params?.shouldDrop ??
      ((body: unknown) => {
        if (!body || typeof body !== "object") {
          return false;
        }
        const raw = body as { api_app_id?: string; team_id?: string };
        return raw.api_app_id === "A_WRONG" || raw.team_id === "T_WRONG";
      }),
    resolveSlackSystemEventSessionKey: vi.fn(
      (input: {
        channelId?: string | null;
        channelType?: string | null;
        senderId?: string | null;
      }) =>
        `session:${input.channelType ?? "unknown"}:${input.channelId ?? "none"}:${input.senderId ?? "none"}`,
    ),
    resolveChannelName: vi.fn(async () => ({ name: "general", type: "channel" })),
    resolveUserName: vi.fn(async () => ({ name: "alice" })),
    isChannelAllowed: vi.fn(() => true),
    setSlackThreadStatus: vi.fn(),
  } as unknown as SlackMonitorContext;

  return {
    ctx,
    account: makeAccount({
      bridgeEnabled: params?.bridgeEnabled,
      policy: params?.policy,
    }),
    handlers,
    loggerInfo,
    markMessageSeen,
    trackEvent,
    trackEventMock,
  };
}

async function invokeFirst(
  harness: TestHarness,
  eventName: string,
  event: Record<string, unknown>,
  body: unknown,
): Promise<void> {
  const handler = harness.handlers.get(eventName)?.[0];
  expect(handler).toBeTruthy();
  await handler!({ event, body });
}

async function invokeAll(
  harness: TestHarness,
  eventName: string,
  event: Record<string, unknown>,
  body: unknown,
): Promise<void> {
  const handlers = harness.handlers.get(eventName) ?? [];
  expect(handlers.length).toBeGreaterThan(0);
  for (const handler of handlers) {
    await handler({ event, body });
  }
}

function registerAssistant(harness: TestHarness): void {
  registerSlackAssistantEvents({
    ctx: harness.ctx,
    account: harness.account,
    trackEvent: harness.trackEvent,
  });
}

describe("registerSlackAssistantEvents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers assistant thread and assistant-pane message handlers", () => {
    const harness = createHarness();

    registerAssistant(harness);

    expect(Array.from(harness.handlers.keys())).toEqual([
      "assistant_thread_started",
      "assistant_thread_context_changed",
      "message",
      "assistant_user_message",
    ]);
  });

  it("normalizes assistant_thread_started into assistant surface context", async () => {
    const harness = createHarness({ bridgeEnabled: false });
    registerAssistant(harness);

    await invokeFirst(
      harness,
      "assistant_thread_started",
      assistantThreadStartedFixture.event,
      assistantThreadStartedFixture,
    );

    const metadata = getAssistantSurfaceMetadata(harness.ctx, {
      channelId: "D123ABC456",
      threadTs: "1729999327.187299",
      userId: "U123ABC456",
    });
    expect(metadata).toMatchObject({
      accountId: "bench-aurelius",
      apiAppId: "A123ABC456",
      teamId: "T123ABC456",
      channelId: "D123ABC456",
      activeChannelId: "C123ABC456",
      activeTeamId: "T07XY8FPJ5C",
      userId: "U123ABC456",
      threadTs: "1729999327.187299",
      eventType: "assistant_thread_started",
      surfaceType: "assistant-pane",
      sessionKey: "session:channel:C123ABC456:U123ABC456",
      policy: "inherit",
    });
    expect(harness.trackEventMock).toHaveBeenCalledTimes(1);
    expect(harness.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "assistant_thread_started",
        surface_type: "assistant-pane",
        channel_id: "D123ABC456",
        user_id: "U123ABC456",
        ts: "1715873754.429808",
      }),
      "slack assistant event",
    );
  });

  it("updates assistant surface context on assistant_thread_context_changed", async () => {
    const harness = createHarness({ bridgeEnabled: false });
    registerAssistant(harness);

    await invokeFirst(
      harness,
      "assistant_thread_started",
      assistantThreadStartedFixture.event,
      assistantThreadStartedFixture,
    );
    await invokeFirst(
      harness,
      "assistant_thread_context_changed",
      assistantThreadContextChangedFixture.event,
      assistantThreadContextChangedFixture,
    );

    const metadata = getAssistantSurfaceMetadata(harness.ctx, {
      channelId: "D123ABC456",
      threadTs: "1729999327.187299",
      userId: "U123ABC456",
    });
    expect(metadata).toMatchObject({
      activeChannelId: "C987XYZ654",
      eventType: "assistant_thread_context_changed",
      sessionKey: "session:channel:C987XYZ654:U123ABC456",
    });
    expect(harness.trackEventMock).toHaveBeenCalledTimes(2);
  });

  it("suppresses legacy message.im processing for assistant-pane user turns", async () => {
    const harness = createHarness({ bridgeEnabled: true });
    const handleSlackMessage = vi.fn(async () => {}) as SlackMessageHandler;

    registerSlackAssistantEvents({
      ctx: harness.ctx,
      account: harness.account,
      trackEvent: harness.trackEvent,
    });
    registerSlackMessageEvents({
      ctx: harness.ctx,
      handleSlackMessage,
    });

    await invokeFirst(
      harness,
      "assistant_thread_started",
      assistantThreadStartedFixture.event,
      assistantThreadStartedFixture,
    );
    expect(
      getAssistantSurfaceMetadata(harness.ctx, {
        channelId: "D123ABC456",
        threadTs: "1729999327.187299",
        userId: "U123ABC456",
      }),
    ).toBeTruthy();
    await invokeAll(
      harness,
      "message",
      assistantMessageImFixture.event as SlackMessageEvent,
      assistantMessageImFixture,
    );

    expect(harness.ctx.runtime.error).not.toHaveBeenCalled();
    expect(harness.markMessageSeen).toHaveBeenCalledWith("D123ABC456", "1729999350.000200");
    expect(handleSlackMessage).not.toHaveBeenCalled();
    expect(harness.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        bridge_intent: "would_call_bridge",
        duplicate_suppression_branch: "a",
        event_type: "message.im",
      }),
      "slack assistant bridge intent",
    );
  });

  it("drops mismatched app/team events without recording assistant context", async () => {
    const harness = createHarness();
    registerAssistant(harness);

    await invokeFirst(harness, "assistant_thread_started", assistantThreadStartedFixture.event, {
      ...assistantThreadStartedFixture,
      api_app_id: "A_WRONG",
    });

    expect(harness.trackEventMock).not.toHaveBeenCalled();
    expect(harness.loggerInfo).not.toHaveBeenCalled();
    expect(
      getAssistantSurfaceMetadata(harness.ctx, {
        channelId: "D123ABC456",
        threadTs: "1729999327.187299",
        userId: "U123ABC456",
      }),
    ).toBeUndefined();
  });

  it("records assistant turns without bridge intent when bridge is disabled", async () => {
    const harness = createHarness({ bridgeEnabled: false });
    registerAssistant(harness);

    await invokeFirst(
      harness,
      "assistant_thread_started",
      assistantThreadStartedFixture.event,
      assistantThreadStartedFixture,
    );
    await invokeAll(
      harness,
      "message",
      assistantMessageImFixture.event as SlackMessageEvent,
      assistantMessageImFixture,
    );

    expect(harness.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "message.im",
        surface_type: "assistant-pane",
      }),
      "slack assistant event",
    );
    expect(
      harness.loggerInfo.mock.calls.some(([fields]) =>
        Boolean((fields as { bridge_intent?: unknown }).bridge_intent),
      ),
    ).toBe(false);
  });

  it("emits a bridge intent for defensive separate assistant user-turn events", async () => {
    const harness = createHarness({ bridgeEnabled: true });
    registerAssistant(harness);

    await invokeFirst(
      harness,
      "assistant_user_message",
      {
        type: "assistant_user_message",
        assistant_thread: {
          user_id: "U123ABC456",
          channel_id: "D123ABC456",
          thread_ts: "1729999327.187299",
          context: {
            channel_id: "C123ABC456",
            team_id: "T07XY8FPJ5C",
          },
        },
        event_ts: "1729999351.000100",
      },
      {
        ...assistantMessageImFixture,
        event_id: "EvASSISTANTUSERMESSAGE1",
      },
    );

    expect(harness.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        bridge_intent: "would_call_bridge",
        duplicate_suppression_branch: "b",
        event_type: "assistant_user_message",
      }),
      "slack assistant bridge intent",
    );
  });
});
