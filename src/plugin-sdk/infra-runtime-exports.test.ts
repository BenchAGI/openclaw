import { describe, expect, it } from "vitest";
import { renderPluginSdkApiBaseline } from "./api-baseline.js";

describe("deprecated infra-runtime plugin approval boundary", () => {
  it("retains shipped approval values and types without exporting internal turn budgets", async () => {
    const { modules } = await renderPluginSdkApiBaseline({
      repoRoot: process.cwd(),
      entrypoints: ["infra-runtime"],
    });
    const exports = modules[0].exports;
    // Public contract from stable v2026.9.2: retain both type and value exports.
    // The internal idle-budget additions must not grow this compatibility API.
    expect(
      Object.fromEntries(exports.map(({ exportName, kind }) => [exportName, kind])),
    ).toMatchObject({
      PluginApprovalActionView: "type",
      PluginApprovalRequestPayload: "type",
      PluginApprovalRequest: "type",
      PluginApprovalResolved: "type",
      DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS: "const",
      MAX_PLUGIN_APPROVAL_TIMEOUT_MS: "const",
      PLUGIN_APPROVAL_TITLE_MAX_LENGTH: "const",
      PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH: "const",
      PLUGIN_APPROVAL_DETAIL_MAX_LENGTH: "const",
      DEFAULT_PLUGIN_APPROVAL_DECISIONS: "const",
      resolvePluginApprovalTimeoutMs: "function",
      approvalDecisionLabel: "function",
      resolvePluginApprovalRequestAllowedDecisions: "function",
      buildPluginApprovalRequestMessage: "function",
      buildPluginApprovalResolvedMessage: "function",
      buildPluginApprovalExpiredMessage: "function",
      truncatePluginApprovalDetail: "function",
    });
    const names = exports.map(({ exportName }) => exportName);
    for (const internalName of [
      "DEFAULT_TURN_IDLE_BUDGET_MS",
      "TURN_IDLE_REPLY_RESERVE_MS",
      "resolveApprovalWaitCeilingMs",
    ]) {
      expect(names).not.toContain(internalName);
    }
  });
});
