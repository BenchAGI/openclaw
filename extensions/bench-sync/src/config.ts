// Resolve bench-sync activation + runtime knobs from gateway.benchCloud config.
//
// The bench-sync background loop only runs when the Bench cloud bridge is
// enabled, instance-scoped cloud auth is configured, and at least one of
// workboardSync / skillSync is enabled. Poll interval comes from
// workboardSync.pollIntervalMs (default 15000).

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { coerceSecretRef } from "openclaw/plugin-sdk/secret-input-runtime";

export const DEFAULT_POLL_INTERVAL_MS = 15_000;
export const DEFAULT_API_BASE_URL = "https://benchagi.com";

export type BenchSyncInactiveReason =
  | "benchCloud.enabled is false"
  | "gateway.benchCloud.instanceId is unset"
  | "gateway.benchCloud.apiKeyRef is unset"
  | "no sync feature enabled (workboardSync / skillSync)";

export type BenchSyncRuntimeConfig =
  | {
      active: true;
      apiBaseUrl: string;
      instanceId: string;
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

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function boolFromEnv(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "1" || value.toLowerCase() === "true") {
    return true;
  }
  if (value === "0" || value.toLowerCase() === "false") {
    return false;
  }
  return undefined;
}

/**
 * Decide whether the bench-sync loop should run and with what cadence.
 *
 * No-op unless the Bench cloud bridge is enabled by config/env AND
 * (workboardSync.enabled OR skillSync.enabled) AND an instance id + API
 * SecretRef are configured. Returns a discriminated result so callers can log
 * the exact inactive reason without re-deriving it.
 */
export function resolveBenchSyncRuntimeConfig(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BenchSyncRuntimeConfig {
  const benchCloud = config.gateway?.benchCloud ?? {};
  const enabled =
    benchCloud.enabled ??
    boolFromEnv(env.BENCH_CLOUD_BRIDGE_ENABLED) ??
    boolFromEnv(env.BENCH_CLI_REMOTE_BRAIN_BRIDGE_ENABLED) ??
    false;
  if (!enabled) {
    return { active: false, inactiveReason: "benchCloud.enabled is false" };
  }
  const instanceId =
    normalizeNonEmptyString(benchCloud.instanceId) ??
    normalizeNonEmptyString(env.BENCH_INSTANCE_ID);
  if (!instanceId) {
    return { active: false, inactiveReason: "gateway.benchCloud.instanceId is unset" };
  }
  if (!coerceSecretRef(benchCloud.apiKeyRef, config.secrets?.defaults)) {
    return { active: false, inactiveReason: "gateway.benchCloud.apiKeyRef is unset" };
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
    apiBaseUrl:
      normalizeNonEmptyString(benchCloud.apiBaseUrl) ??
      normalizeNonEmptyString(env.BENCH_CLOUD_API_BASE_URL) ??
      normalizeNonEmptyString(env.BENCHAGI_API_BASE_URL) ??
      DEFAULT_API_BASE_URL,
    instanceId,
    pollIntervalMs: positivePollInterval(benchCloud.workboardSync?.pollIntervalMs),
    workboardSyncEnabled,
    skillSyncEnabled,
    mirrorPendingUp: Boolean(benchCloud.skillSync?.mirrorPendingUp),
  };
}
