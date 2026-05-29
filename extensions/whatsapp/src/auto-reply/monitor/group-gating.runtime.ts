export {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "@benchagi/openclaw/plugin-sdk/channel-inbound";
export { hasControlCommand } from "@benchagi/openclaw/plugin-sdk/command-detection";
export { recordPendingHistoryEntryIfEnabled } from "@benchagi/openclaw/plugin-sdk/reply-history";
export { parseActivationCommand } from "@benchagi/openclaw/plugin-sdk/reply-runtime";
export { normalizeE164 } from "../../text-runtime.js";
