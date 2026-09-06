/**
 * Slack-side emission of the `message_sent` plugin hook.
 *
 * Mirrors the Telegram pattern in `extensions/telegram/src/bot/delivery.replies.ts`
 * (`buildTelegramSentHookContext`, `emitMessageSentHooks`, `emitTelegramMessageSentHooks`).
 *
 * Without this, plugins observing `message_sent` see Telegram outbound but not
 * Slack outbound — even though `docs/plugins/hooks.md` documents the hook as
 * firing for all successful outbound deliveries.
 */
import {
  buildCanonicalSentMessageHookContext,
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageSentContext,
  toPluginMessageContext,
  toPluginMessageSentEvent,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

const sendLogger = createSubsystemLogger("slack/send");

/**
 * Record every outbound Slack delivery, successful or not.
 *
 * Telegram logs `telegram outbound send ok` on every send; Slack logged
 * nothing. The gap is not cosmetic — with inbound `app_mention` lines but no
 * outbound record, a gateway log can show a day of user questions and give no
 * evidence that any of them were answered. "Did the assistant reply?" then has
 * to be asked of a human instead of read from the log, and a silent delivery
 * failure is indistinguishable from a quiet day.
 *
 * Content is never logged — only the routing envelope and the outcome. On
 * failure the Slack error string is included, because `channel_not_found` and
 * `not_in_channel` are the two that actually happen and both are actionable.
 */
function logSlackOutboundDelivery(params: EmitSlackMessageSentHookParams): void {
  const parts = [`slack outbound send ${params.success ? "ok" : "FAILED"}`, `to=${params.to}`];
  if (params.accountId) {
    parts.push(`accountId=${params.accountId}`);
  }
  if (params.messageId) {
    parts.push(`messageId=${params.messageId}`);
  }
  if (params.isGroup) {
    parts.push(`isGroup=true`);
  }
  if (params.groupId) {
    parts.push(`groupId=${params.groupId}`);
  }
  // Length, not content: enough to tell an empty reply from a real one.
  parts.push(`chars=${params.content?.length ?? 0}`);
  if (!params.success && params.error) {
    parts.push(`error=${params.error}`);
  }
  const line = parts.join(" ");
  if (params.success) {
    sendLogger.info(line);
  } else {
    sendLogger.error(line);
  }
}

type EmitSlackMessageSentHookParams = {
  /** Optional canonical session key. When set, the internal `message:sent` hook fires too. */
  sessionKeyForInternalHooks?: string;
  /** Slack target (channel ID `C…`, DM channel ID `D…`, group `G…`, or user ID `U…`). */
  to: string;
  accountId?: string | null;
  /** The outbound content that was sent. Mirrors `MessageSentEvent.content`. */
  content: string;
  success: boolean;
  error?: string;
  /** Slack message `ts` returned by `chat.postMessage` on success. */
  messageId?: string;
  isGroup?: boolean;
  groupId?: string;
};

function buildSlackSentHookContext(params: EmitSlackMessageSentHookParams) {
  return buildCanonicalSentMessageHookContext({
    to: params.to,
    content: params.content,
    success: params.success,
    error: params.error,
    channelId: "slack",
    accountId: params.accountId ?? undefined,
    conversationId: params.to,
    // Mirror the canonical session key into the `message_sent` hook context so
    // plugins observing both `message_sending` and `message_sent` see the same
    // `sessionKey` (and it matches the value the internal `message:sent` hook
    // fires with). This matches the shared outbound emitter in
    // `src/infra/outbound/deliver.ts`.
    sessionKey: params.sessionKeyForInternalHooks,
    messageId: params.messageId,
    isGroup: params.isGroup,
    groupId: params.groupId,
  });
}

function emitInternalSlackMessageSentHook(params: EmitSlackMessageSentHookParams): void {
  if (!params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildSlackSentHookContext(params);
  fireAndForgetHook(
    triggerInternalHook(
      createInternalHookEvent(
        "message",
        "sent",
        params.sessionKeyForInternalHooks,
        toInternalMessageSentContext(canonical),
      ),
    ),
    "slack: message:sent internal hook failed",
  );
}

function emitMessageSentHooks(
  params: EmitSlackMessageSentHookParams & {
    hookRunner: ReturnType<typeof getGlobalHookRunner>;
    enabled: boolean;
  },
): void {
  if (!params.enabled && !params.sessionKeyForInternalHooks) {
    return;
  }
  const canonical = buildSlackSentHookContext(params);
  if (params.enabled) {
    fireAndForgetHook(
      Promise.resolve(
        params.hookRunner!.runMessageSent(
          toPluginMessageSentEvent(canonical),
          toPluginMessageContext(canonical),
        ),
      ),
      "slack: message_sent plugin hook failed",
    );
  }
  emitInternalSlackMessageSentHook(params);
}

/**
 * Fire both the plugin `message_sent` hook and (if a session key is supplied)
 * the internal `message:sent` hook for a successful or failed Slack outbound
 * delivery.
 *
 * Safe to call after every `chat.postMessage` — the function self-gates on
 * `hookRunner.hasHooks("message_sent")` so plugins not observing the hook
 * incur no cost.
 */
export function emitSlackMessageSentHooks(params: EmitSlackMessageSentHookParams): void {
  // Logged unconditionally, BEFORE the hook gating below. The hook path
  // self-gates on registered listeners, so an operator with no plugins would
  // otherwise still have no outbound record at all.
  logSlackOutboundDelivery(params);
  const hookRunner = getGlobalHookRunner();
  emitMessageSentHooks({
    ...params,
    hookRunner,
    enabled: hookRunner?.hasHooks("message_sent") ?? false,
  });
}
