// Private runtime barrel for the bundled IRC extension.
// Keep this barrel thin and generic-only.

export type { BaseProbeResult } from "@benchagi/openclaw/plugin-sdk/channel-contract";
export type { ChannelPlugin } from "@benchagi/openclaw/plugin-sdk/channel-core";
export type { OpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";
export type { PluginRuntime } from "@benchagi/openclaw/plugin-sdk/runtime-store";
export type { RuntimeEnv } from "@benchagi/openclaw/plugin-sdk/runtime";
export type {
  BlockStreamingCoalesceConfig,
  DmConfig,
  DmPolicy,
  GroupPolicy,
  GroupToolPolicyBySenderConfig,
  GroupToolPolicyConfig,
  MarkdownConfig,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export type { OutboundReplyPayload } from "@benchagi/openclaw/plugin-sdk/reply-payload";
export { DEFAULT_ACCOUNT_ID } from "@benchagi/openclaw/plugin-sdk/account-id";
export { buildChannelConfigSchema } from "@benchagi/openclaw/plugin-sdk/channel-config-primitives";
export {
  PAIRING_APPROVED_MESSAGE,
  buildBaseChannelStatusSummary,
} from "@benchagi/openclaw/plugin-sdk/channel-status";
export { createChannelPairingController } from "@benchagi/openclaw/plugin-sdk/channel-pairing";
export { createAccountStatusSink } from "@benchagi/openclaw/plugin-sdk/channel-lifecycle";
export {
  readStoreAllowFromForDmPolicy,
  resolveEffectiveAllowFromLists,
} from "@benchagi/openclaw/plugin-sdk/channel-policy";
export { resolveControlCommandGate } from "@benchagi/openclaw/plugin-sdk/command-auth";
export { dispatchInboundReplyWithBase } from "@benchagi/openclaw/plugin-sdk/inbound-reply-dispatch";
export { chunkTextForOutbound } from "@benchagi/openclaw/plugin-sdk/text-chunking";
export {
  deliverFormattedTextWithAttachments,
  formatTextWithAttachmentLinks,
  resolveOutboundMediaUrls,
} from "@benchagi/openclaw/plugin-sdk/reply-payload";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  isDangerousNameMatchingEnabled,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export { logInboundDrop } from "@benchagi/openclaw/plugin-sdk/channel-inbound";
