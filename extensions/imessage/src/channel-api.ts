import { formatTrimmedAllowFromEntries } from "@benchagi/openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelStatusIssue } from "@benchagi/openclaw/plugin-sdk/channel-contract";
import { PAIRING_APPROVED_MESSAGE } from "@benchagi/openclaw/plugin-sdk/channel-status";
import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
  type OpenClawConfig,
} from "@benchagi/openclaw/plugin-sdk/core";
import { resolveChannelMediaMaxBytes } from "@benchagi/openclaw/plugin-sdk/media-runtime";
import { collectStatusIssuesFromLastError } from "@benchagi/openclaw/plugin-sdk/status-helpers";
import {
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
} from "./config-accessors.js";
import { looksLikeIMessageTargetId, normalizeIMessageMessagingTarget } from "./normalize.js";
export { chunkTextForOutbound } from "@benchagi/openclaw/plugin-sdk/text-chunking";

export {
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  formatTrimmedAllowFromEntries,
  getChatChannelMeta,
  looksLikeIMessageTargetId,
  normalizeIMessageMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveIMessageConfigAllowFrom,
  resolveIMessageConfigDefaultTo,
};

export type { ChannelPlugin, ChannelStatusIssue, OpenClawConfig };
