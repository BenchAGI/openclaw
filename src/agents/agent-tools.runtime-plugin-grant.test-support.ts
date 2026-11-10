import { expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginToolAllowlist } from "../plugins/tool-grant-allowlist.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { resolveConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { createOpenClawTools } from "./openclaw-tools.js";

export function registerRuntimePluginToolGrantCases(
  latestOptions: () => NonNullable<Parameters<typeof createOpenClawTools>[0]>,
) {
  it.each(["coding", undefined] as const)(
    "materializes additive runtime tools with profile=%s while preserving normal deny policy",
    (profile) => {
      const createOpenClawToolsMock = vi.mocked(createOpenClawTools);
      createOpenClawToolsMock.mockClear();
      const config: OpenClawConfig = {
        tools: {
          profile,
          deny: ["workboard_block"],
        },
      };

      createOpenClawCodingTools({
        config,
        conversationCapabilityProfile: resolveConversationCapabilityProfile({
          config,
          runtimePluginToolGrant: {
            pluginId: "workboard",
            toolNames: [
              "workboard_read",
              "workboard_proof",
              "workboard_heartbeat",
              "workboard_complete",
            ],
          },
        }),
      });

      expect(createOpenClawToolsMock).toHaveBeenCalledTimes(1);
      const options = latestOptions();
      expect(options.pluginToolAllowlist).not.toContain("workboard_heartbeat");
      const allowlist = createPluginToolAllowlist(options.pluginToolAllowlist);
      expect(allowlist.allowsTool("workboard", "workboard_heartbeat")).toBe(true);
      expect(allowlist.allowsTool("workboard", "workboard_read")).toBe(true);
      expect(allowlist.allowsTool("workboard", "workboard_proof")).toBe(true);
      expect(allowlist.allowsTool("other-plugin", "workboard_proof")).toBe(false);
      expect(allowlist.includesDefaults).toBe(profile === undefined);
      expect(options).not.toHaveProperty("runtimePluginToolGrant");
      expect(options.pluginToolDenylist).toEqual(expect.arrayContaining(["workboard_block"]));
    },
  );
}
