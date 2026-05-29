export { getChatChannelMeta, type ChannelPlugin } from "@benchagi/openclaw/plugin-sdk/core";
export { buildChannelConfigSchema, WhatsAppConfigSchema } from "../config-api.js";
export { DEFAULT_ACCOUNT_ID } from "@benchagi/openclaw/plugin-sdk/account-id";
export {
  formatWhatsAppConfigAllowFromEntries,
  resolveWhatsAppConfigAllowFrom,
  resolveWhatsAppConfigDefaultTo,
} from "./config-accessors.js";
export {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
  ToolAuthorizationError,
} from "@benchagi/openclaw/plugin-sdk/channel-actions";
export { normalizeE164 } from "@benchagi/openclaw/plugin-sdk/account-resolution";
export type { DmPolicy, GroupPolicy } from "@benchagi/openclaw/plugin-sdk/config-runtime";
import type { OpenClawConfig as RuntimeOpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";

export { type ChannelMessageActionName } from "@benchagi/openclaw/plugin-sdk/channel-contract";
export { loadOutboundMediaFromUrl } from "./outbound-media.runtime.js";
export {
  resolveWhatsAppGroupRequireMention,
  resolveWhatsAppGroupToolPolicy,
} from "./group-policy.js";
export {
  resolveWhatsAppGroupIntroHint,
  resolveWhatsAppMentionStripRegexes,
} from "./group-intro.js";
export { resolveWhatsAppHeartbeatRecipients } from "./heartbeat-recipients.js";
export { createWhatsAppOutboundBase } from "./outbound-base.js";
export {
  isWhatsAppGroupJid,
  isWhatsAppUserTarget,
  looksLikeWhatsAppTargetId,
  normalizeWhatsAppAllowFromEntries,
  normalizeWhatsAppMessagingTarget,
  normalizeWhatsAppTarget,
} from "./normalize-target.js";
export { resolveWhatsAppOutboundTarget } from "./resolve-outbound-target.js";
export { resolveWhatsAppReactionLevel } from "./reaction-level.js";

export type OpenClawConfig = RuntimeOpenClawConfig;
export type { WhatsAppAccountConfig } from "./account-types.js";

type MonitorWebChannel = typeof import("./channel.runtime.js").monitorWebChannel;

let channelRuntimePromise: Promise<typeof import("./channel.runtime.js")> | null = null;

function loadChannelRuntime() {
  channelRuntimePromise ??= import("./channel.runtime.js");
  return channelRuntimePromise;
}

export async function monitorWebChannel(
  ...args: Parameters<MonitorWebChannel>
): ReturnType<MonitorWebChannel> {
  const { monitorWebChannel } = await loadChannelRuntime();
  return await monitorWebChannel(...args);
}
