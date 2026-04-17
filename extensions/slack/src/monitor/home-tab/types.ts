/**
 * Public contract for the Slack Home tab renderer. Users implement a module
 * exporting either a default function or a named `renderHome` with this shape.
 *
 * The Slack extension invokes the renderer on every `app_home_opened` event
 * (subject to the in-process cache), then publishes the returned blocks via
 * `views.publish`.
 *
 * See `docs/channels/slack.md` ("Home tab") for the config shape.
 */

export interface SlackHomeRenderInput {
  /** Config accountId this view is being rendered for (e.g. "aurelius"). */
  accountId: string;
  /** Slack user id opening the Home tab. */
  slackUserId: string;
  /** Slack team / workspace id. */
  teamId: string;
  /** Bot user id for this account. */
  botUserId: string;
  /** Timestamp the handler decided to render (not the Slack event timestamp). */
  generatedAt: Date;
}

export interface SlackHomeRenderResult {
  /** KnownBlock-shaped array. Slack caps at 100 blocks. */
  blocks: object[];
  /** Optional private_metadata passed through to views.publish. */
  privateMetadata?: string;
  /** Optional callback_id passed through to views.publish. */
  callbackId?: string;
}

export type SlackHomeRenderer = (input: SlackHomeRenderInput) => Promise<SlackHomeRenderResult>;

/** Runtime-resolved shape of `SlackAccountConfig.homeTab`. */
export interface ResolvedSlackHomeTab {
  enabled: boolean;
  rendererModule: string | null;
  cacheTtlMs: number;
  maxBlocks: number;
}
