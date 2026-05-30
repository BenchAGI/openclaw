// Private runtime barrel for the bundled Mattermost extension.
// Keep this barrel thin and generic-only.

export type {
  BaseProbeResult,
  ChannelAccountSnapshot,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelPlugin,
  ChatType,
  HistoryEntry,
  OpenClawConfig,
  OpenClawPluginApi,
  PluginRuntime,
} from "@benchagi/openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "@benchagi/openclaw/plugin-sdk/runtime";
export type { ReplyPayload } from "@benchagi/openclaw/plugin-sdk/reply-runtime";
export type { ModelsProviderData } from "@benchagi/openclaw/plugin-sdk/command-auth";
export type {
  BlockStreamingCoalesceConfig,
  DmPolicy,
  GroupPolicy,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createDedupeCache,
  parseStrictPositiveInteger,
  resolveClientIp,
  isTrustedProxyAddress,
} from "@benchagi/openclaw/plugin-sdk/core";
export { buildComputedAccountStatusSnapshot } from "@benchagi/openclaw/plugin-sdk/channel-status";
export { createAccountStatusSink } from "@benchagi/openclaw/plugin-sdk/channel-lifecycle";
export { buildAgentMediaPayload } from "@benchagi/openclaw/plugin-sdk/agent-media-payload";
export {
  buildModelsProviderData,
  listSkillCommandsForAgents,
  resolveControlCommandGate,
  resolveStoredModelOverride,
} from "@benchagi/openclaw/plugin-sdk/command-auth";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  isDangerousNameMatchingEnabled,
  loadSessionStore,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  resolveStorePath,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export { formatInboundFromLabel } from "@benchagi/openclaw/plugin-sdk/channel-inbound";
export { logInboundDrop } from "@benchagi/openclaw/plugin-sdk/channel-inbound";
export { createChannelPairingController } from "@benchagi/openclaw/plugin-sdk/channel-pairing";
export {
  DM_GROUP_ACCESS_REASON,
  readStoreAllowFromForDmPolicy,
  resolveDmGroupAccessWithLists,
  resolveEffectiveAllowFromLists,
} from "@benchagi/openclaw/plugin-sdk/channel-policy";
export { evaluateSenderGroupAccessForPolicy } from "@benchagi/openclaw/plugin-sdk/group-access";
export { createChannelReplyPipeline } from "@benchagi/openclaw/plugin-sdk/channel-reply-pipeline";
export { logTypingFailure } from "@benchagi/openclaw/plugin-sdk/channel-feedback";
export { loadOutboundMediaFromUrl } from "@benchagi/openclaw/plugin-sdk/outbound-media";
export { rawDataToString } from "@benchagi/openclaw/plugin-sdk/browser-node-runtime";
export { chunkTextForOutbound } from "@benchagi/openclaw/plugin-sdk/text-chunking";
export {
  DEFAULT_GROUP_HISTORY_LIMIT,
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
  recordPendingHistoryEntryIfEnabled,
} from "@benchagi/openclaw/plugin-sdk/reply-history";
export { normalizeAccountId, resolveThreadSessionKeys } from "@benchagi/openclaw/plugin-sdk/routing";
export { resolveAllowlistMatchSimple } from "@benchagi/openclaw/plugin-sdk/allow-from";
export { registerPluginHttpRoute } from "@benchagi/openclaw/plugin-sdk/webhook-targets";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "@benchagi/openclaw/plugin-sdk/webhook-ingress";
export {
  applyAccountNameToChannelSection,
  applySetupAccountConfigPatch,
  migrateBaseNameToDefaultAccount,
} from "@benchagi/openclaw/plugin-sdk/setup";
export {
  getAgentScopedMediaLocalRoots,
  resolveChannelMediaMaxBytes,
} from "@benchagi/openclaw/plugin-sdk/media-runtime";
export { normalizeProviderId } from "@benchagi/openclaw/plugin-sdk/provider-model-shared";
export { setMattermostRuntime } from "./src/runtime.js";
