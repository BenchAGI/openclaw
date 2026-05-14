import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type {
  SlackAgentKitBridgePolicy,
  SlackAssistantThread,
  SlackAssistantThreadContextChangedEvent,
  SlackAssistantThreadStartedEvent,
  SlackAssistantUserMessageEvent,
  SlackMessageEvent,
} from "../../types.js";
import {
  getAssistantSurfaceMetadata,
  markAssistantSurface,
  type SlackAssistantBridgePolicy,
  type SlackAssistantSurfaceMetadata,
  type SlackMonitorContext,
} from "../context.js";

type SlackAssistantEventHandler<Event> = (args: { event: Event; body: unknown }) => Promise<void>;

type SlackAssistantEventRegistrar = {
  event: <Event>(name: string, handler: SlackAssistantEventHandler<Event>) => void;
};

type SlackAssistantEventBody = {
  api_app_id?: unknown;
  team_id?: unknown;
  event_id?: unknown;
};

type BridgeConfigLike = {
  enabled?: unknown;
  policy?: unknown;
};

const ASSISTANT_USER_MESSAGE_EVENT = "assistant_user_message";

function normalizeBridgePolicy(account: ResolvedSlackAccount): SlackAssistantBridgePolicy {
  const config = account.config.agentKitBridge as BridgeConfigLike | undefined;
  const policy = config?.policy;
  if (policy === "dm" || policy === "channel" || policy === "disabled") {
    return policy;
  }
  return "inherit";
}

function isBridgeEnabled(account: ResolvedSlackAccount): boolean {
  const config = account.config.agentKitBridge as BridgeConfigLike | undefined;
  return Boolean(config?.enabled) && normalizeBridgePolicy(account) !== "disabled";
}

function isAssistantMessageIm(event: SlackMessageEvent): boolean {
  return event.type === "message" && event.channel_type === "im" && Boolean(event.thread_ts);
}

function readAssistantThread(
  event:
    | SlackAssistantThreadStartedEvent
    | SlackAssistantThreadContextChangedEvent
    | SlackAssistantUserMessageEvent
    | SlackMessageEvent,
): SlackAssistantThread | undefined {
  // TODO(W2.1, capture-real-event): verify field assistant_thread on live assistant event payloads.
  return "assistant_thread" in event ? event.assistant_thread : undefined;
}

function readBodyEventId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const eventId = (body as SlackAssistantEventBody).event_id;
  return typeof eventId === "string" ? eventId : undefined;
}

function readBodyTeamId(body: unknown): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const teamId = (body as SlackAssistantEventBody).team_id;
  return typeof teamId === "string" ? teamId : undefined;
}

function buildAssistantEventKey(params: {
  accountId: string;
  eventType: string;
  body: unknown;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  ts?: string;
}): string {
  const eventId = readBodyEventId(params.body);
  if (eventId) {
    return `slack:assistant:event:${params.accountId}:${eventId}`;
  }
  return [
    "slack:assistant:event",
    params.accountId,
    params.eventType,
    params.channelId ?? "unknown-channel",
    params.threadTs ?? "unknown-thread",
    params.userId ?? "unknown-user",
    params.ts ?? "unknown-ts",
  ].join(":");
}

function resolvePolicyChannel(params: {
  policy: SlackAgentKitBridgePolicy;
  assistantChannelId: string;
  activeChannelId?: string;
}): { channelId: string; channelType: "im" | "channel" } {
  if (params.policy === "channel") {
    return {
      channelId: params.activeChannelId ?? params.assistantChannelId,
      channelType: params.activeChannelId ? "channel" : "im",
    };
  }
  if (params.policy === "inherit" && params.activeChannelId) {
    return {
      channelId: params.activeChannelId,
      channelType: "channel",
    };
  }
  return {
    channelId: params.assistantChannelId,
    channelType: "im",
  };
}

function normalizeAssistantSurface(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  eventType: string;
  event:
    | SlackAssistantThreadStartedEvent
    | SlackAssistantThreadContextChangedEvent
    | SlackAssistantUserMessageEvent
    | SlackMessageEvent;
  body: unknown;
  fallback?: SlackAssistantSurfaceMetadata;
}): SlackAssistantSurfaceMetadata | undefined {
  const { ctx, account, event, eventType, body, fallback } = params;
  const assistantThread = readAssistantThread(event);

  // TODO(W2.1, capture-real-event): verify assistant_thread.channel_id/thread_ts/user_id names.
  const channelId =
    assistantThread?.channel_id ??
    ("channel" in event ? event.channel : undefined) ??
    fallback?.channelId;
  const threadTs =
    assistantThread?.thread_ts ??
    ("thread_ts" in event ? event.thread_ts : undefined) ??
    fallback?.threadTs;
  const userId =
    assistantThread?.user_id ?? ("user" in event ? event.user : undefined) ?? fallback?.userId;
  // TODO(W2.1, capture-real-event): verify assistant_thread.context.channel_id/team_id names.
  const activeChannelId = assistantThread?.context?.channel_id ?? fallback?.activeChannelId;
  const activeTeamId =
    assistantThread?.context?.team_id ??
    fallback?.activeTeamId ??
    ("team" in event ? event.team : undefined) ??
    readBodyTeamId(body);
  const ts = ("event_ts" in event ? event.event_ts : undefined) ?? fallback?.ts;

  if (!channelId || !threadTs || !userId) {
    return undefined;
  }

  const policy = normalizeBridgePolicy(account);
  const policyChannel = resolvePolicyChannel({
    policy,
    assistantChannelId: channelId,
    activeChannelId,
  });
  const sessionKey = ctx.resolveSlackSystemEventSessionKey({
    channelId: policyChannel.channelId,
    channelType: policyChannel.channelType,
    senderId: userId,
  });

  return markAssistantSurface(ctx, {
    accountId: account.accountId,
    apiAppId: ctx.apiAppId,
    teamId: ctx.teamId || readBodyTeamId(body),
    channelId,
    userId,
    threadTs,
    activeChannelId,
    activeTeamId,
    eventType,
    surfaceType: "assistant-pane",
    sessionKey,
    policy,
    ts,
  });
}

function logAssistantAudit(
  ctx: SlackMonitorContext,
  metadata: SlackAssistantSurfaceMetadata,
): void {
  ctx.logger.info(
    {
      account_id: metadata.accountId,
      api_app_id: metadata.apiAppId,
      team_id: metadata.teamId,
      active_channel_id: metadata.activeChannelId,
      channel_id: metadata.channelId,
      user_id: metadata.userId,
      event_type: metadata.eventType,
      surface_type: metadata.surfaceType,
      thread_ts: metadata.threadTs,
      session_key: metadata.sessionKey,
      policy: metadata.policy,
      ts: metadata.ts,
    },
    "slack assistant event",
  );
}

function logBridgeIntent(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  metadata: SlackAssistantSurfaceMetadata;
  duplicateSuppressionBranch: "a" | "b";
}): void {
  if (!isBridgeEnabled(params.account)) {
    return;
  }
  params.ctx.logger.info(
    {
      bridge_intent: "would_call_bridge",
      account_id: params.metadata.accountId,
      api_app_id: params.metadata.apiAppId,
      team_id: params.metadata.teamId,
      active_channel_id: params.metadata.activeChannelId,
      channel_id: params.metadata.channelId,
      user_id: params.metadata.userId,
      event_type: params.metadata.eventType,
      surface_type: params.metadata.surfaceType,
      thread_ts: params.metadata.threadTs,
      session_key: params.metadata.sessionKey,
      policy: params.metadata.policy,
      ts: params.metadata.ts,
      duplicate_suppression_branch: params.duplicateSuppressionBranch,
    },
    "slack assistant bridge intent",
  );
}

export function registerSlackAssistantEvents(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  trackEvent?: () => void;
}): void {
  const { ctx, account, trackEvent } = params;
  const app = ctx.app as unknown as SlackAssistantEventRegistrar;
  const seenAssistantEvents = new Set<string>();

  const handleAssistantThreadEvent = async (
    event: SlackAssistantThreadStartedEvent | SlackAssistantThreadContextChangedEvent,
    body: unknown,
  ) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      const metadata = normalizeAssistantSurface({
        ctx,
        account,
        eventType: event.type,
        event,
        body,
      });
      if (!metadata) {
        return;
      }
      const key = buildAssistantEventKey({
        accountId: account.accountId,
        eventType: event.type,
        body,
        channelId: metadata.channelId,
        threadTs: metadata.threadTs,
        userId: metadata.userId,
        ts: metadata.ts,
      });
      if (seenAssistantEvents.has(key)) {
        return;
      }
      seenAssistantEvents.add(key);
      trackEvent?.();
      logAssistantAudit(ctx, metadata);
    } catch (err) {
      ctx.runtime.error?.(danger(`slack assistant handler failed: ${String(err)}`));
    }
  };

  const handleAssistantMessageIm = async (event: SlackMessageEvent, body: unknown) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body) || !isAssistantMessageIm(event)) {
        return;
      }
      const fallback = getAssistantSurfaceMetadata(ctx, {
        channelId: event.channel,
        threadTs: event.thread_ts,
        userId: event.user,
      });
      const hasInlineAssistantThread = Boolean(readAssistantThread(event));
      if (!fallback && !hasInlineAssistantThread) {
        return;
      }

      const metadata = normalizeAssistantSurface({
        ctx,
        account,
        eventType: "message.im",
        event,
        body,
        fallback,
      });
      if (!metadata) {
        return;
      }
      const wasSeen = ctx.markMessageSeen(event.channel, event.ts);
      if (wasSeen) {
        return;
      }
      trackEvent?.();
      logAssistantAudit(ctx, metadata);
      // Branch (a): Slack delivers the assistant user turn as message.im, either with
      // assistant_thread metadata or with thread_ts linked to a prior assistant_thread_started event.
      logBridgeIntent({ ctx, account, metadata, duplicateSuppressionBranch: "a" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack assistant message handler failed: ${String(err)}`));
    }
  };

  const handleAssistantUserMessage = async (
    event: SlackAssistantUserMessageEvent,
    body: unknown,
  ) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      const metadata = normalizeAssistantSurface({
        ctx,
        account,
        eventType: event.type,
        event,
        body,
      });
      if (!metadata) {
        return;
      }
      const key = buildAssistantEventKey({
        accountId: account.accountId,
        eventType: event.type,
        body,
        channelId: metadata.channelId,
        threadTs: metadata.threadTs,
        userId: metadata.userId,
        ts: metadata.ts,
      });
      if (seenAssistantEvents.has(key)) {
        return;
      }
      seenAssistantEvents.add(key);
      trackEvent?.();
      logAssistantAudit(ctx, metadata);
      // Branch (b): keep a defensive handler for Slack runtimes that expose assistant
      // user turns as a distinct assistant event instead of message.im.
      logBridgeIntent({ ctx, account, metadata, duplicateSuppressionBranch: "b" });
    } catch (err) {
      ctx.runtime.error?.(danger(`slack assistant user-message handler failed: ${String(err)}`));
    }
  };

  app.event("assistant_thread_started", async ({ event, body }) => {
    await handleAssistantThreadEvent(event as SlackAssistantThreadStartedEvent, body);
  });
  app.event("assistant_thread_context_changed", async ({ event, body }) => {
    await handleAssistantThreadEvent(event as SlackAssistantThreadContextChangedEvent, body);
  });
  app.event("message", async ({ event, body }) => {
    await handleAssistantMessageIm(event as SlackMessageEvent, body);
  });
  app.event(ASSISTANT_USER_MESSAGE_EVENT, async ({ event, body }) => {
    await handleAssistantUserMessage(event as SlackAssistantUserMessageEvent, body);
  });
}
