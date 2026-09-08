// Slack plugin module implements setup shared behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { patchChannelConfigForAccount } from "openclaw/plugin-sdk/setup-runtime";
import { formatDocsLink } from "openclaw/plugin-sdk/setup-tools";
import { isSlackSetupAccountConfigured } from "./account-configured.js";
import type { ResolvedSlackAccount } from "./accounts.js";
import type { OpenClawConfig } from "./channel-api.js";

export const SLACK_CHANNEL = "slack" as const;

/** Bench fork #96: Slack Agent experience vs. ordinary bot install. */
export type SlackManifestMode = "agent" | "bot";

export function buildSlackManifest(botName = "OpenClaw", mode: SlackManifestMode = "agent") {
  const safeName = botName.trim() || "OpenClaw";
  // Slack's display_name contract is lowercase with no spaces.
  const botDisplayName =
    safeName
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "openclaw";
  const manifest = {
    display_information: {
      name: safeName,
      description: `${safeName} connector for OpenClaw`,
    },
    features: {
      bot_user: {
        display_name: botDisplayName,
        always_online: true,
      },
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      ...(mode === "agent"
        ? {
            agent_view: {
              agent_description: `${safeName} connects Slack Agent View conversations to OpenClaw agents.`,
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
          ...(mode === "agent" ? ["assistant:write"] : []),
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
          ...(mode === "agent"
            ? ["app_context_changed", "agent_session_stopped", "agent_session_title_changed"]
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

/**
 * @public Bench fork: exercised directly by its test.
 */
export function buildSlackSetupChoiceLines(): string[] {
  return [
    "Slack can be installed as an Agent experience or an ordinary bot.",
    "Agent mode uses Slack's current Agent schema but may require a paid plan and is unavailable to workspace guests.",
    "Interactive setup asks which mode to use; quickstart uses the universally supported ordinary bot manifest.",
  ];
}

export function buildSlackSetupLines(mode: SlackManifestMode = "agent"): string[] {
  // Bench fork #96: upstream's numbered steps stay verbatim; the Agent-vs-bot
  // guidance rides as an extra line so both experiences share one checklist.
  const modeLine =
    mode === "agent"
      ? "Agents & AI Apps -> enable the Agent experience before pasting the manifest"
      : "Keep Agents & AI Apps disabled for an ordinary bot install";
  return [
    "1) Slack API -> Create App -> From scratch or a transport-specific manifest",
    "2) Install App to workspace to get the xoxb- bot token",
    "3) Socket Mode: enable it and create an app-level token (xapp-...)",
    "4) HTTP: configure a public HTTPS Request URL and copy the app Signing Secret",
    "5) Enable Event Subscriptions for message, App Home, and Agent View events",
    mode === "agent"
      ? "6) App Home -> enable the Home tab, Messages tab for DMs, and Agent View"
      : "6) App Home -> enable the Home tab and Messages tab for DMs",
    modeLine,
    "Manifest JSON follows as plain text for copy/paste.",
    "Tip: Socket Mode can use SLACK_BOT_TOKEN + SLACK_APP_TOKEN in your env.",
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

export function describeSlackSetupAccount(account: ResolvedSlackAccount) {
  return describeAccountSnapshot({
    account,
    configured: isSlackSetupAccountConfigured(account),
    extra: {
      botTokenSource: account.botTokenSource,
      appTokenSource: account.appTokenSource,
      ...(account.identity === "user"
        ? { identity: account.identity, userTokenSource: account.userTokenSource }
        : {}),
    },
  });
}
