import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_IDLE_BUDGET_MS,
  MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
  TURN_IDLE_REPLY_RESERVE_MS,
  resolveApprovalWaitCeilingMs,
  resolvePluginApprovalTimeoutMs,
} from "./plugin-approvals.js";

const ENV_KEY = "OPENCLAW_TURN_IDLE_BUDGET_MS";

function withBudget(value: string | undefined, run: () => void): void {
  const prior = process.env[ENV_KEY];
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
  try {
    run();
  } finally {
    if (prior === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = prior;
    }
  }
}

afterEach(() => {
  delete process.env[ENV_KEY];
});

describe("resolveApprovalWaitCeilingMs", () => {
  it("leaves reply headroom inside the default budget", () => {
    withBudget(undefined, () => {
      expect(resolveApprovalWaitCeilingMs()).toBe(
        DEFAULT_TURN_IDLE_BUDGET_MS - TURN_IDLE_REPLY_RESERVE_MS,
      );
    });
  });

  it("mirrors the Codex app-server turnCompletionIdleTimeoutMs default", () => {
    // Pins the cross-package assumption documented on DEFAULT_TURN_IDLE_BUDGET_MS.
    // The real default lives at extensions/codex/src/app-server/config.ts:677 and
    // cannot be imported here without core depending on an extension package. If that
    // default moves, this fails and the constant must move with it.
    expect(DEFAULT_TURN_IDLE_BUDGET_MS).toBe(60_000);
  });

  it("tracks a runtime-configured budget", () => {
    withBudget("300000", () => {
      expect(resolveApprovalWaitCeilingMs()).toBe(300_000 - TURN_IDLE_REPLY_RESERVE_MS);
    });
  });

  it("disables clamping when the runtime has no idle killer", () => {
    withBudget("0", () => {
      expect(resolveApprovalWaitCeilingMs()).toBe(MAX_PLUGIN_APPROVAL_TIMEOUT_MS);
    });
  });

  it("never returns a non-positive window when the budget is under the reserve", () => {
    withBudget("10000", () => {
      const ceiling = resolveApprovalWaitCeilingMs();
      expect(ceiling).toBeGreaterThan(0);
      expect(ceiling).toBeLessThanOrEqual(10_000);
    });
  });

  it("ignores malformed overrides rather than blocking approvals", () => {
    for (const raw of ["", "   ", "not-a-number", "-5"]) {
      withBudget(raw, () => {
        expect(resolveApprovalWaitCeilingMs()).toBe(
          DEFAULT_TURN_IDLE_BUDGET_MS - TURN_IDLE_REPLY_RESERVE_MS,
        );
      });
    }
  });
});

describe("resolvePluginApprovalTimeoutMs (shared, out-of-turn)", () => {
  // Regression guard for the defect Anvil caught on this PR: an earlier revision
  // clamped the shared resolver, silently shortening gateway approvals that run
  // outside any host turn and have no idle timer counting against them.
  it("does not apply the in-turn ceiling", () => {
    withBudget(undefined, () => {
      expect(resolvePluginApprovalTimeoutMs(MAX_PLUGIN_APPROVAL_TIMEOUT_MS)).toBe(
        MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
      );
    });
  });

  it("still clamps to the supported runtime bounds", () => {
    withBudget(undefined, () => {
      expect(resolvePluginApprovalTimeoutMs(MAX_PLUGIN_APPROVAL_TIMEOUT_MS + 1)).toBe(
        MAX_PLUGIN_APPROVAL_TIMEOUT_MS,
      );
      expect(resolvePluginApprovalTimeoutMs(0)).toBe(1);
    });
  });
});
