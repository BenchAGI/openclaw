// Private runtime barrel for the bundled Feishu extension.
// Keep this barrel thin and generic-only.

export type {
  AllowlistMatch,
  AnyAgentTool,
  BaseProbeResult,
  ChannelGroupContext,
  ChannelMessageActionName,
  ChannelMeta,
  ChannelOutboundAdapter,
  ChannelPlugin,
  HistoryEntry,
  OpenClawConfig,
  OpenClawPluginApi,
  OutboundIdentity,
  PluginRuntime,
  ReplyPayload,
} from "@benchagi/openclaw/plugin-sdk/core";
export type { OpenClawConfig as ClawdbotConfig } from "@benchagi/openclaw/plugin-sdk/core";
export type { RuntimeEnv } from "@benchagi/openclaw/plugin-sdk/runtime";
export type { GroupToolPolicyConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";
export {
  DEFAULT_ACCOUNT_ID,
  buildChannelConfigSchema,
  createActionGate,
  createDedupeCache,
} from "@benchagi/openclaw/plugin-sdk/core";
export {
  PAIRING_APPROVED_MESSAGE,
  buildProbeChannelStatusSummary,
  createDefaultChannelRuntimeState,
} from "@benchagi/openclaw/plugin-sdk/channel-status";
export { buildAgentMediaPayload } from "@benchagi/openclaw/plugin-sdk/agent-media-payload";
export { createChannelPairingController } from "@benchagi/openclaw/plugin-sdk/channel-pairing";
export { createReplyPrefixContext } from "@benchagi/openclaw/plugin-sdk/channel-reply-pipeline";
export {
  evaluateSupplementalContextVisibility,
  filterSupplementalContextItems,
  resolveChannelContextVisibilityMode,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export { loadSessionStore, resolveSessionStoreEntry } from "@benchagi/openclaw/plugin-sdk/config-runtime";
export { readJsonFileWithFallback } from "@benchagi/openclaw/plugin-sdk/json-store";
export { createPersistentDedupe } from "@benchagi/openclaw/plugin-sdk/persistent-dedupe";
export { normalizeAgentId } from "@benchagi/openclaw/plugin-sdk/routing";
export { chunkTextForOutbound } from "@benchagi/openclaw/plugin-sdk/text-chunking";
export {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "@benchagi/openclaw/plugin-sdk/webhook-ingress";
export { setFeishuRuntime } from "./src/runtime.js";
