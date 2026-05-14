import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentKitBridgeClient,
  BridgeError,
  BridgeRunRequest,
  BridgeRunResponse,
} from "../agent-kit-bridge.js";
import { dispatchAssistantBridgeTurn } from "./dispatch-assistant.js";
import type { PreparedSlackMessage } from "./types.js";

type CapturedLog = {
  level: "info" | "warn" | "error";
  args: unknown[];
};

function captureLogger() {
  const entries: CapturedLog[] = [];
  return {
    entries,
    logger: {
      info: (...args: unknown[]) => entries.push({ level: "info", args }),
      warn: (...args: unknown[]) => entries.push({ level: "warn", args }),
      error: (...args: unknown[]) => entries.push({ level: "error", args }),
    },
  };
}

function successfulResponse(overrides: Partial<BridgeRunResponse> = {}): BridgeRunResponse {
  return {
    response_text: "bridge response",
    session_id: "claude-session-1",
    tool_intents: [],
    ...overrides,
  };
}

function bridgeError(code: BridgeError["code"]): BridgeError {
  return {
    code,
    message: `${code} failed`,
    retryable: code !== "runtime_error",
    latency_ms: 42,
  };
}

function createBridgeClient(run: AgentKitBridgeClient["run"]): AgentKitBridgeClient {
  return {
    healthz: async () => ({ ok: true, latency_ms: 1 }),
    run,
  };
}

function createPreparedSlackMessage(
  overrides: {
    responseText?: string;
    channelId?: string | null;
    threadTs?: string | null;
    teamId?: string;
    accountId?: string;
    userId?: string;
    messageText?: string;
    messageChannel?: string;
    messageTs?: string;
  } = {},
): { prepared: PreparedSlackMessage; logs: CapturedLog[] } {
  const { logger, entries } = captureLogger();
  const accountId = overrides.accountId ?? "bench-aurelius";
  const teamId = overrides.teamId ?? "T123";
  const channelId = overrides.channelId === undefined ? "C123" : overrides.channelId;
  const threadTs = overrides.threadTs === undefined ? "1715620000.000100" : overrides.threadTs;
  const userId = overrides.userId ?? "U123";
  const messageChannel = overrides.messageChannel ?? "DASSIST";
  const messageTs = overrides.messageTs ?? "1715620001.000200";
  const messageText = overrides.messageText ?? "raw user text must not be logged";

  return {
    logs: entries,
    prepared: {
      ctx: {
        cfg: {},
        runtime: {},
        botToken: "xoxb-test",
        app: { client: {} },
        logger,
        textLimit: 4000,
      },
      account: {
        accountId,
        config: {
          agentKitBridge: {
            enabled: true,
            url: "http://127.0.0.1:8717",
            timeoutMs: 60000,
            mode: "runtime-adapter",
            policy: "inherit",
          },
        },
      },
      message: {
        type: "message",
        channel: messageChannel,
        channel_type: "im",
        user: userId,
        text: messageText,
        ts: messageTs,
        thread_ts: threadTs ?? undefined,
      },
      route: {
        agentId: "agent-1",
        accountId,
        mainSessionKey: "main-session",
      },
      channelConfig: null,
      replyTarget: `channel:${messageChannel}`,
      ctxPayload: {
        BodyForAgent: messageText,
        MessageThreadId: threadTs ?? messageTs,
        account_id: accountId,
        team_id: teamId,
        app_id: "A123",
        channel_id: channelId,
        thread_ts: threadTs,
        user_id: userId,
        surface_type: "assistant_pane",
        turn_source_event: "message.im",
        turn_source_ts: messageTs,
      },
      replyToMode: "all",
      isDirectMessage: true,
      isRoomish: false,
      historyKey: "history-key",
      preview: "",
      ackReactionValue: "eyes",
      ackReactionPromise: null,
    } as unknown as PreparedSlackMessage,
  };
}

function stringifyLogs(logs: CapturedLog[]): string {
  return logs.map((entry) => JSON.stringify(entry.args)).join("\n");
}

describe("dispatchAssistantBridgeTurn", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("calls the bridge with the prepared assistant context, posts response, and stores session id", async () => {
    const { prepared, logs } = createPreparedSlackMessage();
    const requests: BridgeRunRequest[] = [];
    const bridgeClient = createBridgeClient(async (req) => {
      requests.push(req);
      return { ok: true, value: successfulResponse() };
    });
    const deliverReplies = vi.fn(async () => {});

    await dispatchAssistantBridgeTurn(prepared, {
      bridgeClient,
      deliverReplies,
      nowMs: () => 100,
    });

    expect(requests).toEqual([
      {
        session_key: "T123:bench-aurelius:C123:1715620000.000100:U123",
        user_text: "raw user text must not be logged",
        surface_context: {
          account_id: "bench-aurelius",
          team_id: "T123",
          app_id: "A123",
          channel_id: "C123",
          thread_ts: "1715620000.000100",
          user_id: "U123",
          surface_type: "assistant_pane",
          turn_source_event: "message.im",
          turn_source_ts: "1715620001.000200",
        },
      },
    ]);
    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "bridge response" }],
        target: "channel:DASSIST",
        token: "xoxb-test",
        replyThreadTs: "1715620000.000100",
      }),
    );
    expect(stringifyLogs(logs)).not.toContain("raw user text must not be logged");
    expect(stringifyLogs(logs)).not.toContain("bridge response");
  });

  it("passes the stored session id on the second turn for the same session key", async () => {
    const first = createPreparedSlackMessage({
      teamId: "T-resume",
      channelId: "C-resume",
      threadTs: "200.001",
      userId: "U-resume",
      messageText: "first message",
    });
    const second = createPreparedSlackMessage({
      teamId: "T-resume",
      channelId: "C-resume",
      threadTs: "200.001",
      userId: "U-resume",
      messageText: "second message",
    });
    const requests: BridgeRunRequest[] = [];
    const bridgeClient = createBridgeClient(async (req) => {
      requests.push(req);
      return {
        ok: true,
        value: successfulResponse({
          session_id: requests.length === 1 ? "claude-session-resume" : "claude-session-2",
        }),
      };
    });
    const deliverReplies = vi.fn(async () => {});

    await dispatchAssistantBridgeTurn(first.prepared, { bridgeClient, deliverReplies });
    await dispatchAssistantBridgeTurn(second.prepared, { bridgeClient, deliverReplies });

    expect(requests[0]?.resume_session_id).toBeUndefined();
    expect(requests[1]?.resume_session_id).toBe("claude-session-resume");
  });

  it("posts a graceful timeout fallback and logs structured metadata only", async () => {
    const { prepared, logs } = createPreparedSlackMessage({
      teamId: "T-timeout",
      channelId: "C-timeout",
      threadTs: "300.001",
    });
    const bridgeClient = createBridgeClient(async () => ({
      ok: false,
      error: bridgeError("timeout"),
    }));
    const deliverReplies = vi.fn(async () => {});

    await dispatchAssistantBridgeTurn(prepared, { bridgeClient, deliverReplies });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [
          {
            text: "I'm having trouble reaching my Claude SDK runtime — try again in a moment.",
          },
        ],
      }),
    );
    const logsText = stringifyLogs(logs);
    expect(logsText).toContain("bridge_run_failed");
    expect(logsText).toContain("timeout");
    expect(logsText).not.toContain("raw user text must not be logged");
  });

  it("posts a runtime-error fallback and logs structured metadata only", async () => {
    const { prepared, logs } = createPreparedSlackMessage({
      teamId: "T-runtime",
      channelId: "C-runtime",
      threadTs: "400.001",
      messageText: "runtime input must not be logged",
    });
    const bridgeClient = createBridgeClient(async () => ({
      ok: false,
      error: bridgeError("runtime_error"),
    }));
    const deliverReplies = vi.fn(async () => {});

    await dispatchAssistantBridgeTurn(prepared, { bridgeClient, deliverReplies });

    expect(deliverReplies).toHaveBeenCalledWith(
      expect.objectContaining({
        replies: [{ text: "My runtime hit an error working on that. Try again or rephrase?" }],
      }),
    );
    const logsText = stringifyLogs(logs);
    expect(logsText).toContain("bridge_run_failed");
    expect(logsText).toContain("runtime_error");
    expect(logsText).not.toContain("runtime input must not be logged");
  });

  it("executes slack_reaction_add tool intents with the existing reaction helper", async () => {
    const { prepared, logs } = createPreparedSlackMessage({
      teamId: "T-tool",
      channelId: "C-tool",
      threadTs: "500.001",
      messageText: "tool input must not be logged",
    });
    const bridgeClient = createBridgeClient(async () => ({
      ok: true,
      value: successfulResponse({
        response_text: "tool response must not be logged",
        tool_intents: [
          {
            type: "slack_reaction_add",
            channel: "C-tool",
            ts: "500.001",
            name: "eyes",
          },
        ],
      }),
    }));
    const deliverReplies = vi.fn(async () => {});
    const reactSlackMessage = vi.fn(async () => {});

    const result = await dispatchAssistantBridgeTurn(prepared, {
      bridgeClient,
      deliverReplies,
      reactSlackMessage,
    });

    expect(result.toolIntentExecutedCount).toBe(1);
    expect(reactSlackMessage).toHaveBeenCalledWith("C-tool", "500.001", "eyes", {
      token: "xoxb-test",
      client: prepared.ctx.app.client,
    });
    const logsText = stringifyLogs(logs);
    expect(logsText).not.toContain("tool input must not be logged");
    expect(logsText).not.toContain("tool response must not be logged");
  });
});
