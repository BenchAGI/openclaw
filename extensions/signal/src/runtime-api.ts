// Private runtime barrel for the bundled Signal extension.
// Prefer narrower SDK subpaths plus local extension seams over the legacy signal barrel.

export type { ChannelMessageActionAdapter } from "@benchagi/openclaw/plugin-sdk/channel-contract";
export { buildChannelConfigSchema, SignalConfigSchema } from "../config-api.js";
export { PAIRING_APPROVED_MESSAGE } from "@benchagi/openclaw/plugin-sdk/channel-status";
import type { OpenClawConfig as RuntimeOpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";
export type { RuntimeOpenClawConfig as OpenClawConfig };
export type { OpenClawPluginApi, PluginRuntime } from "@benchagi/openclaw/plugin-sdk/core";
export type { ChannelPlugin } from "@benchagi/openclaw/plugin-sdk/core";
export {
  DEFAULT_ACCOUNT_ID,
  applyAccountNameToChannelSection,
  deleteAccountFromConfigSection,
  emptyPluginConfigSchema,
  formatPairingApproveHint,
  getChatChannelMeta,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  setAccountEnabledInConfigSection,
} from "@benchagi/openclaw/plugin-sdk/core";
export { resolveChannelMediaMaxBytes } from "@benchagi/openclaw/plugin-sdk/media-runtime";
export { formatCliCommand, formatDocsLink } from "@benchagi/openclaw/plugin-sdk/setup-tools";
export { chunkText } from "@benchagi/openclaw/plugin-sdk/reply-runtime";
export { detectBinary } from "@benchagi/openclaw/plugin-sdk/setup-tools";
export {
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
} from "@benchagi/openclaw/plugin-sdk/status-helpers";
export { normalizeE164 } from "@benchagi/openclaw/plugin-sdk/text-runtime";
export { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";
export {
  listEnabledSignalAccounts,
  listSignalAccountIds,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
} from "./accounts.js";
export { monitorSignalProvider } from "./monitor.js";
export { installSignalCli } from "./install-signal-cli.js";
export { probeSignal } from "./probe.js";
export { resolveSignalReactionLevel } from "./reaction-level.js";
export { removeReactionSignal, sendReactionSignal } from "./send-reactions.js";
export { sendMessageSignal } from "./send.js";
export { signalMessageActions } from "./message-actions.js";
export type { ResolvedSignalAccount } from "./accounts.js";
export type { SignalAccountConfig } from "./account-types.js";
