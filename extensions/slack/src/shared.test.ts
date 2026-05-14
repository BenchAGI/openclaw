import { describe, expect, it } from "vitest";
import { buildSlackSetupLines, createSlackPluginBase, setSlackChannelAllowlist } from "./shared.js";

type SlackManifestForTest = {
  features: {
    app_home: {
      home_tab_enabled: boolean;
      messages_tab_enabled: boolean;
      messages_tab_read_only_enabled: boolean;
    };
    assistant_view: {
      assistant_description: string;
      suggested_prompts: Array<{
        title: string;
        message: string;
      }>;
    };
  };
  oauth_config: {
    scopes: {
      bot: string[];
      user?: string[];
    };
  };
  settings: {
    event_subscriptions: {
      bot_events: string[];
    };
  };
};

const expectedSlackManifestBotScopes = [
  "app_mentions:read",
  "assistant:write",
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
  "users:read",
];

const expectedSlackManifestBotEvents = [
  "app_home_opened",
  "app_mention",
  "assistant_thread_started",
  "assistant_thread_context_changed",
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
];

function parseSlackSetupManifest(): SlackManifestForTest {
  const setupLines = buildSlackSetupLines("Aurelius");
  const manifestText = setupLines.at(-1);

  expect(manifestText).toBeTypeOf("string");

  return JSON.parse(manifestText ?? "{}") as SlackManifestForTest;
}

describe("createSlackPluginBase", () => {
  it("owns Slack native command name overrides", () => {
    const plugin = createSlackPluginBase({
      setup: {} as never,
      setupWizard: {} as never,
    });

    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "status",
        defaultName: "status",
      }),
    ).toBe("agentstatus");
    expect(
      plugin.commands?.resolveNativeCommandName?.({
        commandKey: "tts",
        defaultName: "tts",
      }),
    ).toBe("tts");
  });

  it("generates the Slack manifest with preserved bot scopes and Agent Kit scope", () => {
    const manifest = parseSlackSetupManifest();

    expect(manifest.oauth_config.scopes.bot).toEqual(expectedSlackManifestBotScopes);
    expect(manifest.oauth_config.scopes.bot).toContain("assistant:write");
    expect(manifest.oauth_config.scopes.user).toBeUndefined();
  });

  it("generates the Slack manifest with preserved event subscriptions and Agent Kit events", () => {
    const manifest = parseSlackSetupManifest();

    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expectedSlackManifestBotEvents,
    );
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining([
        "app_home_opened",
        "assistant_thread_started",
        "assistant_thread_context_changed",
      ]),
    );
  });

  it("generates the Slack manifest with assistant view and app home features", () => {
    const manifest = parseSlackSetupManifest();

    expect(manifest.features.app_home).toEqual({
      home_tab_enabled: true,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    });
    expect(manifest.features.assistant_view).toEqual({
      assistant_description:
        "I observe, contextualize, and route. Ask me what's happening, who's discussing what, or who should own this.",
      suggested_prompts: [
        {
          title: "What's in the forge?",
          message: "What's in the forge?",
        },
        {
          title: "Recent threads I missed",
          message: "Recent threads I missed",
        },
        {
          title: "Who's talking about deploys?",
          message: "Who's talking about deploys?",
        },
        {
          title: "Introduce yourself",
          message: "Introduce yourself",
        },
      ],
    });
  });
});

describe("setSlackChannelAllowlist", () => {
  it("writes canonical enabled entries for setup-generated channel allowlists", () => {
    const result = setSlackChannelAllowlist(
      {
        channels: {
          slack: {
            accounts: {
              work: {},
            },
          },
        },
      },
      "work",
      ["C123", "C456"],
    );

    expect(result.channels?.slack?.accounts?.work?.channels).toEqual({
      C123: { enabled: true },
      C456: { enabled: true },
    });
  });
});
