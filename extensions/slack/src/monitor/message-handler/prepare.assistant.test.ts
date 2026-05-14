import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import { markAssistantSurface, type SlackMonitorContext } from "../context.js";
import { prepareSlackMessage } from "./prepare.js";
import {
  createInboundSlackTestContext,
  createSlackSessionStoreFixture,
  createSlackTestAccount,
} from "./prepare.test-helpers.js";

describe("prepareSlackMessage assistant turn context", () => {
  const storeFixture = createSlackSessionStoreFixture("openclaw-slack-assistant-prepare-");

  beforeAll(() => {
    storeFixture.setup();
  });

  afterAll(() => {
    storeFixture.cleanup();
  });

  function createConfig(): OpenClawConfig {
    const { storePath } = storeFixture.makeTmpStorePath();
    return {
      session: { store: storePath },
      channels: { slack: { enabled: true, groupPolicy: "open" } },
    } as OpenClawConfig;
  }

  function createCtx(params?: {
    channelsConfig?: Parameters<typeof createInboundSlackTestContext>[0]["channelsConfig"];
  }): SlackMonitorContext {
    const ctx = createInboundSlackTestContext({
      cfg: createConfig(),
      channelsConfig: params?.channelsConfig,
      defaultRequireMention: false,
    });
    ctx.resolveUserName = async () => ({ name: "Alice" });
    ctx.resolveChannelName = vi.fn(async (channelId: string) => ({
      name: channelId === "C123" ? "project" : undefined,
      type: channelId.startsWith("C") ? ("channel" as const) : ("im" as const),
    }));
    return ctx;
  }

  function createAccount(config: ResolvedSlackAccount["config"] = {}): ResolvedSlackAccount {
    return createSlackTestAccount({
      agentKitBridge: {
        enabled: true,
        url: "http://127.0.0.1:8717",
        timeoutMs: 60000,
        mode: "runtime-adapter",
        policy: "inherit",
      },
      ...config,
    });
  }

  function createMessage(overrides: Partial<SlackMessageEvent>): SlackMessageEvent {
    return {
      type: "message",
      channel: "D123",
      channel_type: "im",
      user: "U1",
      text: "hello",
      ts: "101.000",
      event_ts: "101.000",
      ...overrides,
    };
  }

  async function prepare(params: {
    ctx: SlackMonitorContext;
    account?: ResolvedSlackAccount;
    message: SlackMessageEvent;
    source?: "message" | "app_mention";
    wasMentioned?: boolean;
  }) {
    return prepareSlackMessage({
      ctx: params.ctx,
      account: params.account ?? createAccount(),
      message: params.message,
      opts: {
        source: params.source ?? "message",
        wasMentioned: params.wasMentioned,
      },
    });
  }

  function markAssistant(params: {
    ctx: SlackMonitorContext;
    activeChannelId?: string;
    eventType?: string;
  }) {
    markAssistantSurface(params.ctx, {
      accountId: "default",
      apiAppId: "A1",
      teamId: "T1",
      channelId: "DASSIST",
      userId: "U1",
      threadTs: "100.000",
      activeChannelId: params.activeChannelId,
      activeTeamId: params.activeChannelId ? "T1" : undefined,
      eventType: params.eventType ?? "assistant_thread_started",
      surfaceType: "assistant-pane",
      sessionKey: "assistant-session",
      policy: "inherit",
      ts: "100.000",
    });
  }

  function expectIdentityAndTurnSource(
    ctxPayload: NonNullable<Awaited<ReturnType<typeof prepare>>>["ctxPayload"],
    expected: {
      surfaceType: "assistant_pane" | "channel" | "dm";
      channelId: string | null;
      turnSourceEvent: string;
      originatingTo?: string;
    },
  ) {
    expect(ctxPayload.account_id).toBe("default");
    expect(ctxPayload.team_id).toBe("T1");
    expect(ctxPayload.app_id).toBe("A1");
    expect(ctxPayload.user_id).toBe("U1");
    expect(ctxPayload.surface_type).toBe(expected.surfaceType);
    expect(ctxPayload.channel_id).toBe(expected.channelId);
    expect(ctxPayload.turn_source_event).toBe(expected.turnSourceEvent);
    expect(ctxPayload.turn_source_ts).toBe("101.000");
    expect(ctxPayload.OriginatingChannel).toBe("slack");
    expect(ctxPayload.OriginatingTo).toBe(
      expected.originatingTo ?? (expected.surfaceType === "channel" ? "channel:C123" : "user:U1"),
    );
    expect(ctxPayload.AccountId).toBe("default");
  }

  it("applies DM policy for assistant-pane turns without channel context", async () => {
    const ctx = createCtx();
    markAssistant({ ctx });

    const prepared = await prepare({
      ctx,
      message: createMessage({
        channel: "DASSIST",
        thread_ts: "100.000",
      }),
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.isDirectMessage).toBe(true);
    expectIdentityAndTurnSource(prepared!.ctxPayload, {
      surfaceType: "assistant_pane",
      channelId: null,
      turnSourceEvent: "message.im",
      originatingTo: "user:U1",
    });
    expect(prepared!.replyTarget).toBe("channel:DASSIST");
    expect(prepared!.ctxPayload.thread_ts).toBe("100.000");
    expect(prepared!.ctxPayload.assistant_thread_context).toEqual({
      channel_id: null,
      team_id: null,
      thread_ts: null,
      assistant_channel_id: "DASSIST",
      assistant_thread_ts: "100.000",
    });
  });

  it("applies inherited channel policy for assistant-pane turns with channel context", async () => {
    const ctx = createCtx({
      channelsConfig: {
        C123: { users: ["U1"], skills: ["ops"], requireMention: true },
      },
    });
    markAssistant({ ctx, activeChannelId: "C123" });

    const prepared = await prepare({
      ctx,
      message: createMessage({
        channel: "DASSIST",
        thread_ts: "100.000",
      }),
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.channelConfig?.skills).toEqual(["ops"]);
    expectIdentityAndTurnSource(prepared!.ctxPayload, {
      surfaceType: "assistant_pane",
      channelId: "C123",
      turnSourceEvent: "message.im",
      originatingTo: "user:U1",
    });
    expect(prepared!.replyTarget).toBe("channel:DASSIST");
    expect(prepared!.ctxPayload.assistant_thread_context).toMatchObject({
      channel_id: "C123",
      assistant_channel_id: "DASSIST",
      assistant_thread_ts: "100.000",
    });
  });

  it("leaves channel mention context on the existing channel surface", async () => {
    const ctx = createCtx();
    const prepared = await prepare({
      ctx,
      message: createMessage({
        channel: "C123",
        channel_type: "channel",
        text: "<@B1> hello",
      }),
      source: "app_mention",
      wasMentioned: true,
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.isDirectMessage).toBe(false);
    expectIdentityAndTurnSource(prepared!.ctxPayload, {
      surfaceType: "channel",
      channelId: "C123",
      turnSourceEvent: "app_mention",
    });
    expect(prepared!.ctxPayload.assistant_thread_context).toBeUndefined();
  });

  it("leaves direct DM context on the existing DM surface", async () => {
    const ctx = createCtx();
    const prepared = await prepare({
      ctx,
      message: createMessage({ channel: "D123" }),
    });

    expect(prepared).toBeTruthy();
    expect(prepared!.isDirectMessage).toBe(true);
    expectIdentityAndTurnSource(prepared!.ctxPayload, {
      surfaceType: "dm",
      channelId: "D123",
      turnSourceEvent: "message.im",
    });
    expect(prepared!.ctxPayload.assistant_thread_context).toBeUndefined();
  });
});
