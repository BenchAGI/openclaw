import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ResolvedSlackAccount } from "../../accounts.js";
import type { SlackMessageEvent } from "../../types.js";
import type { SlackChannelConfigResolved } from "../channel-config.js";
import type { SlackMonitorContext, SlackPreparedTurnSurfaceContext } from "../context.js";

export interface PreparedSlackMessageContext
  extends FinalizedMsgContext, SlackPreparedTurnSurfaceContext {}

export type PreparedSlackMessage = {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  message: SlackMessageEvent;
  route: ResolvedAgentRoute;
  channelConfig: SlackChannelConfigResolved | null;
  replyTarget: string;
  ctxPayload: PreparedSlackMessageContext;
  replyToMode: "off" | "first" | "all" | "batched";
  isDirectMessage: boolean;
  isRoomish: boolean;
  historyKey: string;
  preview: string;
  ackReactionMessageTs?: string;
  ackReactionValue: string;
  ackReactionPromise: Promise<boolean> | null;
};
