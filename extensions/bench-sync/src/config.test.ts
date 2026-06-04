import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { DEFAULT_POLL_INTERVAL_MS, resolveBenchSyncRuntimeConfig } from "./config.js";

function config(benchCloud?: Record<string, unknown>): OpenClawConfig {
  return { gateway: benchCloud ? { benchCloud } : {} } as unknown as OpenClawConfig;
}

const apiKeyRef = { source: "env", provider: "default", id: "BENCH_INSTANCE_API_KEY" };

describe("resolveBenchSyncRuntimeConfig gating", () => {
  it("is inactive when benchCloud is absent", () => {
    const result = resolveBenchSyncRuntimeConfig(config());
    expect(result.active).toBe(false);
  });

  it("is inactive when benchCloud.enabled is false", () => {
    const result = resolveBenchSyncRuntimeConfig(
      config({ enabled: false, apiKeyRef, workboardSync: { enabled: true } }),
    );
    expect(result).toMatchObject({ active: false, inactiveReason: "benchCloud.enabled is false" });
  });

  it("is inactive when the API key SecretRef is unset", () => {
    const result = resolveBenchSyncRuntimeConfig(
      config({ enabled: true, workboardSync: { enabled: true } }),
    );
    expect(result).toMatchObject({
      active: false,
      inactiveReason: "gateway.benchCloud.apiKeyRef is unset",
    });
  });

  it("is inactive when enabled but no sync feature is on", () => {
    const result = resolveBenchSyncRuntimeConfig(config({ enabled: true, apiKeyRef }));
    expect(result).toMatchObject({
      active: false,
      inactiveReason: "no sync feature enabled (workboardSync / skillSync)",
    });
  });

  it("is active when workboardSync is enabled", () => {
    const result = resolveBenchSyncRuntimeConfig(
      config({ enabled: true, apiKeyRef, workboardSync: { enabled: true } }),
    );
    expect(result).toMatchObject({
      active: true,
      pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
      workboardSyncEnabled: true,
      skillSyncEnabled: false,
    });
  });

  it("is active when only skillSync is enabled", () => {
    const result = resolveBenchSyncRuntimeConfig(
      config({ enabled: true, apiKeyRef, skillSync: { enabled: true, mirrorPendingUp: true } }),
    );
    expect(result).toMatchObject({
      active: true,
      skillSyncEnabled: true,
      mirrorPendingUp: true,
    });
  });

  it("honors a custom pollIntervalMs", () => {
    const result = resolveBenchSyncRuntimeConfig(
      config({ enabled: true, apiKeyRef, workboardSync: { enabled: true, pollIntervalMs: 5000 } }),
    );
    expect(result).toMatchObject({ active: true, pollIntervalMs: 5000 });
  });

  it("falls back to the default for a non-positive pollIntervalMs", () => {
    const result = resolveBenchSyncRuntimeConfig(
      config({ enabled: true, apiKeyRef, workboardSync: { enabled: true, pollIntervalMs: 0 } }),
    );
    expect(result).toMatchObject({ active: true, pollIntervalMs: DEFAULT_POLL_INTERVAL_MS });
  });
});
