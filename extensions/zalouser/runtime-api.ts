// Private runtime barrel for the bundled Zalo Personal extension.
// Keep this barrel thin and aligned with the local extension surface.

export * from "./api.js";
export { setZalouserRuntime } from "./src/runtime.js";
export type { ReplyPayload } from "@benchagi/openclaw/plugin-sdk/reply-runtime";
export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelStatusIssue,
} from "@benchagi/openclaw/plugin-sdk/channel-contract";
export type {
  OpenClawConfig,
  GroupToolPolicyConfig,
  MarkdownTableMode,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export type {
  PluginRuntime,
  AnyAgentTool,
  ChannelPlugin,
  OpenClawPluginToolContext,
} from "@benchagi/openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "@benchagi/openclaw/plugin-sdk/runtime";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  normalizeAccountId,
} from "@benchagi/openclaw/plugin-sdk/core";
export { chunkTextForOutbound } from "@benchagi/openclaw/plugin-sdk/text-chunking";
export {
  isDangerousNameMatchingEnabled,
  resolveDefaultGroupPolicy,
  resolveOpenProviderRuntimeGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export {
  mergeAllowlist,
  summarizeMapping,
  formatAllowFromLowercase,
} from "@benchagi/openclaw/plugin-sdk/allow-from";
export { resolveInboundMentionDecision } from "@benchagi/openclaw/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "@benchagi/openclaw/plugin-sdk/channel-pairing";
export { createChannelReplyPipeline } from "@benchagi/openclaw/plugin-sdk/channel-reply-pipeline";
export { buildBaseAccountStatusSnapshot } from "@benchagi/openclaw/plugin-sdk/status-helpers";
export { resolveSenderCommandAuthorization } from "@benchagi/openclaw/plugin-sdk/command-auth";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "@benchagi/openclaw/plugin-sdk/group-access";
export { loadOutboundMediaFromUrl } from "@benchagi/openclaw/plugin-sdk/outbound-media";
export {
  deliverTextOrMediaReply,
  isNumericTargetId,
  resolveSendableOutboundReplyParts,
  sendPayloadWithChunkedTextAndMedia,
  type OutboundReplyPayload,
} from "@benchagi/openclaw/plugin-sdk/reply-payload";
export { resolvePreferredOpenClawTmpDir } from "@benchagi/openclaw/plugin-sdk/browser-security-runtime";
