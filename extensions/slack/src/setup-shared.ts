// Slack plugin module implements setup shared behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { hasConfiguredSecretInput } from "openclaw/plugin-sdk/secret-input";
import { patchChannelConfigForAccount } from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { isSlackPluginAccountConfigured } from "./account-configured.js";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { OpenClawConfig } from "./channel-api.js";

export const SLACK_CHANNEL = "slack" as const;

export interface SlackManifestOptions {
  /**
   * Include Slack's AI **assistant view** (the assistant pane). Default `false`.
   *
   * When the assistant view is declared, Slack routes DMs to the assistant pane,
   * where they arrive as `message_changed` events that only deliver if metadata
   * resolves exactly one sender - a fragile path that silently drops DMs (see
   * `monitor/events/messages.ts`). With it off (the default), DMs arrive as
   * ordinary `message.im` events and reply through the normal send path. Opt in
   * only once the assistant-pane post-back path is hardened.
   */
  assistantView?: boolean;
}

export function buildSlackManifest(botName = "OpenClaw", options: SlackManifestOptions = {}) {
  const safeName = botName.trim() || "OpenClaw";
  const assistantView = options.assistantView ?? false;
  const manifest = {
    display_information: {
      name: safeName,
      description: `${safeName} connector for OpenClaw`,
    },
    features: {
      bot_user: {
        display_name: safeName,
        always_online: true,
      },
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      ...(assistantView
        ? {
            assistant_view: {
              assistant_description: `${safeName} connects Slack assistant threads to OpenClaw agents.`,
              suggested_prompts: [
                {
                  title: "What can you do?",
                  message: "What can you help me with?",
                },
                {
                  title: "Summarize this channel",
                  message: "Summarize the recent activity in this channel.",
                },
                {
                  title: "Draft a reply",
                  message: "Help me draft a reply.",
                },
              ],
            },
          }
        : {}),
      slash_commands: [
        {
          command: "/openclaw",
          description: "Send a message to OpenClaw",
          should_escape: false,
        },
      ],
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          ...(assistantView ? ["assistant:write"] : []),
          "channels:history",
          "channels:read",
          "chat:write",
          "commands",
          "emoji:read",
          "files:read",
          "files:write",
          "groups:history",
          "groups:read",
          "im:history",
          "im:read",
          "im:write",
          "mpim:history",
          "mpim:read",
          "mpim:write",
          "pins:read",
          "pins:write",
          "reactions:read",
          "reactions:write",
          "usergroups:read",
          "users:read",
        ],
      },
    },
    settings: {
      socket_mode_enabled: true,
      event_subscriptions: {
        bot_events: [
          "app_home_opened",
          "app_mention",
          ...(assistantView
            ? ["assistant_thread_context_changed", "assistant_thread_started"]
            : []),
          "channel_rename",
          "member_joined_channel",
          "member_left_channel",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "pin_added",
          "pin_removed",
          "reaction_added",
          "reaction_removed",
        ],
      },
    },
  };
  return JSON.stringify(manifest, null, 2);
}

export function buildSlackSetupLines(): string[] {
  return [
    "1) Slack API -> Create App -> From scratch or From manifest (with the JSON below)",
    "2) Add Socket Mode + enable it to get the app-level token (xapp-...)",
    "3) Install App to workspace to get the xoxb- bot token",
    "4) Enable Event Subscriptions (socket) for message and App Home events",
    "5) App Home -> enable the Home tab and the Messages tab so DMs reach the bot",
    "Manifest JSON follows as plain text for copy/paste.",
    "Tip: set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
    `Docs: ${formatDocsLink("/slack", "slack")}`,
  ];
}

export function setSlackChannelAllowlist(
  cfg: OpenClawConfig,
  accountId: string,
  channelKeys: string[],
): OpenClawConfig {
  const channels = Object.fromEntries(channelKeys.map((key) => [key, { enabled: true }]));
  return patchChannelConfigForAccount({
    cfg,
    channel: SLACK_CHANNEL,
    accountId,
    patch: { channels },
  });
}

export function isSlackSetupAccountConfigured(account: ResolvedSlackAccount): boolean {
  if (account.config.mode === "relay") {
    return isSlackPluginAccountConfigured(account);
  }
  const hasConfiguredBotToken =
    Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
  const hasConfiguredAppToken =
    Boolean(account.appToken?.trim()) || hasConfiguredSecretInput(account.config.appToken);
  return hasConfiguredBotToken && hasConfiguredAppToken;
}

export function describeSlackSetupAccount(account: ResolvedSlackAccount) {
  return describeAccountSnapshot({
    account,
    configured: isSlackSetupAccountConfigured(account),
    extra: {
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
    },
  });
}
