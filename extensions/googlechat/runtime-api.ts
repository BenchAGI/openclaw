// Private runtime barrel for the bundled Google Chat extension.
// Keep this barrel thin and avoid broad plugin-sdk surfaces during bootstrap.

export { DEFAULT_ACCOUNT_ID } from "@benchagi/openclaw/plugin-sdk/account-id";
export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringParam,
} from "@benchagi/openclaw/plugin-sdk/channel-actions";
export { buildChannelConfigSchema } from "@benchagi/openclaw/plugin-sdk/channel-config-primitives";
export type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelStatusIssue,
} from "@benchagi/openclaw/plugin-sdk/channel-contract";
export { missingTargetError } from "@benchagi/openclaw/plugin-sdk/channel-feedback";
export {
  createAccountStatusSink,
  runPassiveAccountLifecycle,
} from "@benchagi/openclaw/plugin-sdk/channel-lifecycle";
export { createChannelPairingController } from "@benchagi/openclaw/plugin-sdk/channel-pairing";
export { createChannelReplyPipeline } from "@benchagi/openclaw/plugin-sdk/channel-reply-pipeline";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveDmGroupAccessWithLists,
  resolveSenderScopedGroupPolicy,
} from "@benchagi/openclaw/plugin-sdk/channel-policy";
export { PAIRING_APPROVED_MESSAGE } from "@benchagi/openclaw/plugin-sdk/channel-status";
export { chunkTextForOutbound } from "@benchagi/openclaw/plugin-sdk/text-chunking";
export type { OpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export { fetchRemoteMedia, resolveChannelMediaMaxBytes } from "@benchagi/openclaw/plugin-sdk/media-runtime";
export { loadOutboundMediaFromUrl } from "@benchagi/openclaw/plugin-sdk/outbound-media";
export type { PluginRuntime } from "@benchagi/openclaw/plugin-sdk/runtime-store";
export { fetchWithSsrFGuard } from "@benchagi/openclaw/plugin-sdk/ssrf-runtime";
export {
  GoogleChatConfigSchema,
  type GoogleChatAccountConfig,
  type GoogleChatConfig,
} from "@benchagi/openclaw/plugin-sdk/googlechat-runtime-shared";
export { extractToolSend } from "@benchagi/openclaw/plugin-sdk/tool-send";
export { resolveInboundMentionDecision } from "@benchagi/openclaw/plugin-sdk/channel-inbound";
export { resolveInboundRouteEnvelopeBuilderWithRuntime } from "@benchagi/openclaw/plugin-sdk/inbound-envelope";
export { resolveWebhookPath } from "@benchagi/openclaw/plugin-sdk/webhook-path";
export {
  registerWebhookTargetWithPluginRoute,
  resolveWebhookTargetWithAuthOrReject,
  withResolvedWebhookRequestPipeline,
} from "@benchagi/openclaw/plugin-sdk/webhook-targets";
export {
  createWebhookInFlightLimiter,
  readJsonWebhookBodyOrReject,
  type WebhookInFlightLimiter,
} from "@benchagi/openclaw/plugin-sdk/webhook-request-guards";
export { setGoogleChatRuntime } from "./src/runtime.js";
