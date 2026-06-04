// Resolve bench-sync activation + runtime knobs from gateway.benchCloud config.
//
// The bench-sync background loop only runs when the Bench cloud bridge is
// enabled AND at least one of workboardSync / skillSync is enabled. Poll
// interval comes from workboardSync.pollIntervalMs (default 15000).

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;

export type BenchSyncInactiveReason =
  | "benchCloud.enabled is false"
  | "no sync feature enabled (workboardSync / skillSync)";

export type BenchSyncRuntimeConfig =
  | {
      active: true;
      pollIntervalMs: number;
      workboardSyncEnabled: boolean;
      skillSyncEnabled: boolean;
      mirrorPendingUp: boolean;
    }
  | {
      active: false;
      inactiveReason: BenchSyncInactiveReason;
    };

function positivePollInterval(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

/**
 * Decide whether the bench-sync loop should run and with what cadence.
 *
 * No-op unless benchCloud.enabled AND (workboardSync.enabled OR
 * skillSync.enabled). Returns a discriminated result so callers can log the
 * exact inactive reason without re-deriving it.
 */
export function resolveBenchSyncRuntimeConfig(config: OpenClawConfig): BenchSyncRuntimeConfig {
  const benchCloud = config.gateway?.benchCloud;
  if (!benchCloud?.enabled) {
    return { active: false, inactiveReason: "benchCloud.enabled is false" };
  }

  const workboardSyncEnabled = Boolean(benchCloud.workboardSync?.enabled);
  const skillSyncEnabled = Boolean(benchCloud.skillSync?.enabled);
  if (!workboardSyncEnabled && !skillSyncEnabled) {
    return {
      active: false,
      inactiveReason: "no sync feature enabled (workboardSync / skillSync)",
    };
  }

  return {
    active: true,
    pollIntervalMs: positivePollInterval(benchCloud.workboardSync?.pollIntervalMs),
    workboardSyncEnabled,
    skillSyncEnabled,
    mirrorPendingUp: Boolean(benchCloud.skillSync?.mirrorPendingUp),
  };
}
