import { danger } from "openclaw/plugin-sdk/runtime-env";
import { reactSlackMessage, removeSlackReaction } from "../../actions.js";
import {
  type AgentKitBridgeClient,
  type BridgeError,
  type BridgeRunRequest,
  type BridgeRunResponse,
  type BridgeSurfaceContext,
  type BridgeToolIntent,
} from "../agent-kit-bridge.js";
import { getAgentKitBridgeClient } from "../context.js";
import { deliverReplies } from "../replies.js";
import type { PreparedSlackMessage } from "./types.js";

const assistantBridgeSessionIds = new Map<string, string>();
// TODO(W4): persist session-id store across process restarts; add retention window (research Q4).

const TRANSPORT_FALLBACK =
  "I'm having trouble reaching my Claude SDK runtime — try again in a moment.";
const RUNTIME_FALLBACK = "My runtime hit an error working on that. Try again or rephrase?";

type DeliverAssistantReply = typeof deliverReplies;
type SlackReactionAction = typeof reactSlackMessage;

export type DispatchAssistantBridgeDeps = {
  bridgeClient?: AgentKitBridgeClient;
  deliverReplies?: DeliverAssistantReply;
  reactSlackMessage?: SlackReactionAction;
  removeSlackReaction?: SlackReactionAction;
  nowMs?: () => number;
};

function optionalString(value: string | null | undefined): string | undefined {
  return value ?? undefined;
}

function readIntentString(intent: BridgeToolIntent, key: string): string | undefined {
  const value = intent[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function buildAssistantBridgeSessionKey(prepared: PreparedSlackMessage): string {
  const surface = prepared.ctxPayload;
  return [
    surface.team_id || "unknown-team",
    surface.account_id || prepared.account.accountId || "unknown-account",
    surface.channel_id ?? "assistant",
    surface.thread_ts ?? "root",
    surface.user_id || "unknown-user",
  ].join(":");
}

function buildBridgeSurfaceContext(prepared: PreparedSlackMessage): BridgeSurfaceContext {
  const surface = prepared.ctxPayload;
  return {
    account_id: surface.account_id,
    team_id: surface.team_id,
    app_id: surface.app_id,
    channel_id: optionalString(surface.channel_id),
    thread_ts: optionalString(surface.thread_ts),
    user_id: surface.user_id,
    surface_type: surface.surface_type,
    turn_source_event: surface.turn_source_event,
    turn_source_ts: optionalString(surface.turn_source_ts),
  };
}

function buildBridgeRunRequest(prepared: PreparedSlackMessage): BridgeRunRequest {
  const sessionKey = buildAssistantBridgeSessionKey(prepared);
  const resumeSessionId = assistantBridgeSessionIds.get(sessionKey);
  return {
    session_key: sessionKey,
    user_text: prepared.ctxPayload.BodyForAgent ?? prepared.message.text ?? "",
    surface_context: buildBridgeSurfaceContext(prepared),
    ...(resumeSessionId ? { resume_session_id: resumeSessionId } : {}),
  };
}

function logBridgeDecision(prepared: PreparedSlackMessage, sessionKey: string): void {
  prepared.ctx.logger.info(
    {
      event: "bridge_dispatch_selected",
      account_id: prepared.account.accountId,
      surface_type: prepared.ctxPayload.surface_type,
      session_key: sessionKey,
    },
    "slack assistant bridge dispatch selected",
  );
}

function logBridgeSuccess(params: {
  prepared: PreparedSlackMessage;
  sessionKey: string;
  latencyMs: number;
  toolIntentCount: number;
}): void {
  params.prepared.ctx.logger.info(
    {
      event: "bridge_run_succeeded",
      account_id: params.prepared.account.accountId,
      surface_type: params.prepared.ctxPayload.surface_type,
      session_key: params.sessionKey,
      latency_ms: params.latencyMs,
      tool_intent_count: params.toolIntentCount,
    },
    "slack assistant bridge run succeeded",
  );
}

function logBridgeFailure(params: {
  prepared: PreparedSlackMessage;
  sessionKey: string;
  error: BridgeError;
  latencyMs: number;
}): void {
  params.prepared.ctx.logger.warn(
    {
      event: "bridge_run_failed",
      error_code: params.error.code,
      account_id: params.prepared.account.accountId,
      surface_type: params.prepared.ctxPayload.surface_type,
      session_key: params.sessionKey,
      latency_ms: params.latencyMs,
    },
    "slack assistant bridge run failed",
  );
}

async function deliverAssistantText(
  prepared: PreparedSlackMessage,
  text: string,
  deps: Required<Pick<DispatchAssistantBridgeDeps, "deliverReplies">>,
): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  // TODO(streaming): wire chat.startStream / appendStream when sidecar adds streaming /run-stream endpoint
  await deps.deliverReplies({
    replies: [{ text: trimmed }],
    target: prepared.replyTarget,
    token: prepared.ctx.botToken,
    accountId: prepared.account.accountId,
    runtime: prepared.ctx.runtime,
    textLimit: prepared.ctx.textLimit,
    replyThreadTs: prepared.message.thread_ts ?? prepared.message.ts,
    replyToMode: prepared.replyToMode,
  });
}

function logUnknownIntent(prepared: PreparedSlackMessage, intent: BridgeToolIntent): void {
  prepared.ctx.logger.warn(
    {
      event: "bridge_tool_intent_unknown",
      account_id: prepared.account.accountId,
      surface_type: prepared.ctxPayload.surface_type,
      intent_type: typeof intent.type === "string" ? intent.type : undefined,
    },
    "slack assistant bridge ignored unknown tool intent",
  );
}

function logIntentFailure(
  prepared: PreparedSlackMessage,
  intent: BridgeToolIntent,
  error: unknown,
): void {
  prepared.ctx.runtime.error?.(
    danger(
      `slack assistant bridge tool intent failed: type=${
        typeof intent.type === "string" ? intent.type : "unknown"
      } error=${String(error)}`,
    ),
  );
}

async function executeToolIntent(
  prepared: PreparedSlackMessage,
  intent: BridgeToolIntent,
  deps: Required<Pick<DispatchAssistantBridgeDeps, "reactSlackMessage" | "removeSlackReaction">>,
): Promise<boolean> {
  const type = readIntentString(intent, "type");
  if (type !== "slack_reaction_add" && type !== "slack_reaction_remove") {
    logUnknownIntent(prepared, intent);
    return false;
  }

  const channel = readIntentString(intent, "channel");
  const ts = readIntentString(intent, "ts");
  const name = readIntentString(intent, "name");
  if (!channel || !ts || !name) {
    prepared.ctx.logger.warn(
      {
        event: "bridge_tool_intent_invalid",
        account_id: prepared.account.accountId,
        surface_type: prepared.ctxPayload.surface_type,
        intent_type: type,
      },
      "slack assistant bridge ignored invalid tool intent",
    );
    return false;
  }

  try {
    if (type === "slack_reaction_add") {
      await deps.reactSlackMessage(channel, ts, name, {
        token: prepared.ctx.botToken,
        client: prepared.ctx.app.client,
      });
    } else {
      await deps.removeSlackReaction(channel, ts, name, {
        token: prepared.ctx.botToken,
        client: prepared.ctx.app.client,
      });
    }
    return true;
  } catch (error) {
    logIntentFailure(prepared, intent, error);
    return false;
  }
}

async function executeToolIntents(
  prepared: PreparedSlackMessage,
  response: BridgeRunResponse,
  deps: Required<Pick<DispatchAssistantBridgeDeps, "reactSlackMessage" | "removeSlackReaction">>,
): Promise<number> {
  let executed = 0;
  for (const intent of response.tool_intents) {
    if (await executeToolIntent(prepared, intent, deps)) {
      executed += 1;
    }
  }
  return executed;
}

function bridgeFallbackText(error: BridgeError): string {
  return error.code === "runtime_error" ? RUNTIME_FALLBACK : TRANSPORT_FALLBACK;
}

export async function dispatchAssistantBridgeTurn(
  prepared: PreparedSlackMessage,
  deps: DispatchAssistantBridgeDeps = {},
): Promise<{ bridgeCalled: boolean; toolIntentExecutedCount: number }> {
  const bridgeClient = deps.bridgeClient ?? getAgentKitBridgeClient(prepared.ctx);
  const resolvedDeps = {
    deliverReplies: deps.deliverReplies ?? deliverReplies,
    reactSlackMessage: deps.reactSlackMessage ?? reactSlackMessage,
    removeSlackReaction: deps.removeSlackReaction ?? removeSlackReaction,
  };
  const nowMs = deps.nowMs ?? Date.now;
  const req = buildBridgeRunRequest(prepared);
  logBridgeDecision(prepared, req.session_key);

  const start = nowMs();
  const result = await bridgeClient.run(req);
  const latencyMs = nowMs() - start;
  if (!result.ok) {
    if (result.error.code === "disabled") {
      return { bridgeCalled: false, toolIntentExecutedCount: 0 };
    }
    logBridgeFailure({
      prepared,
      sessionKey: req.session_key,
      error: result.error,
      latencyMs,
    });
    await deliverAssistantText(prepared, bridgeFallbackText(result.error), resolvedDeps);
    return { bridgeCalled: true, toolIntentExecutedCount: 0 };
  }

  if (result.value.session_id) {
    assistantBridgeSessionIds.set(req.session_key, result.value.session_id);
  }
  await deliverAssistantText(prepared, result.value.response_text, resolvedDeps);
  const toolIntentExecutedCount = await executeToolIntents(prepared, result.value, resolvedDeps);
  logBridgeSuccess({
    prepared,
    sessionKey: req.session_key,
    latencyMs,
    toolIntentCount: toolIntentExecutedCount,
  });
  return { bridgeCalled: true, toolIntentExecutedCount };
}
