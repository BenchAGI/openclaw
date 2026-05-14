import { describe, expect, it } from "vitest";
import { defaultAgentKitBridgeConfig } from "./agent-kit-bridge-config.js";
import { SlackConfigSchema } from "./runtime-api.js";

describe("Slack agentKitBridge account config", () => {
  it("populates defaults for an empty agentKitBridge block", () => {
    const result = SlackConfigSchema.parse({
      accounts: {
        work: {
          agentKitBridge: {},
        },
      },
    });

    expect(result.accounts?.work?.agentKitBridge).toEqual(defaultAgentKitBridgeConfig());
  });

  it("rejects enabled bridge config without a url", () => {
    const result = SlackConfigSchema.safeParse({
      accounts: {
        work: {
          agentKitBridge: {
            enabled: true,
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join(".") === "accounts.work.agentKitBridge.url",
        ),
      ).toBe(true);
    }
  });

  it("accepts a valid bridge config", () => {
    const result = SlackConfigSchema.parse({
      accounts: {
        work: {
          agentKitBridge: {
            enabled: true,
            url: "http://127.0.0.1:4317",
            timeoutMs: 1500,
            mode: "runtime-adapter",
            policy: "channel",
          },
        },
      },
    });

    expect(result.accounts?.work?.agentKitBridge).toEqual({
      enabled: true,
      url: "http://127.0.0.1:4317",
      timeoutMs: 1500,
      mode: "runtime-adapter",
      policy: "channel",
    });
  });

  it("rejects unknown bridge modes", () => {
    const result = SlackConfigSchema.safeParse({
      accounts: {
        work: {
          agentKitBridge: {
            enabled: true,
            url: "https://127.0.0.1:4317",
            mode: "unknown",
          },
        },
      },
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some(
          (issue) => issue.path.join(".") === "accounts.work.agentKitBridge.mode",
        ),
      ).toBe(true);
    }
  });
});
