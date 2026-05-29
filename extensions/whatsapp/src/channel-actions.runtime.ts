import { createActionGate } from "@benchagi/openclaw/plugin-sdk/channel-actions";
import type { ChannelMessageActionName } from "@benchagi/openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";

export { listWhatsAppAccountIds, resolveWhatsAppAccount } from "./accounts.js";
export { resolveWhatsAppReactionLevel } from "./reaction-level.js";
export { createActionGate, type ChannelMessageActionName, type OpenClawConfig };
