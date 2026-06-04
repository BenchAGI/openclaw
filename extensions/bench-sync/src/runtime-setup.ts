// Shared runtime wiring for the bench-sync loop handlers.
//
// Resolves the cloud transport config (apiBaseUrl / instanceId) and the
// instance API key (SecretRef), then constructs the origin-pinned client. Both
// the B2 workboard mirror and the B3 directive/proposal sync use this so the
// auth + origin-pin path is identical for every handler.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveApiKey } from "./auth.js";
import { BenchSyncClient } from "./client.js";

/** Mirror of cloud-brain-bridge's default base URL (no core import). */
const DEFAULT_API_BASE_URL = "https://benchagi.com";

export type BenchSyncClientSetupResult =
  | { status: "ok"; client: BenchSyncClient; instanceId: string; apiBaseUrl: string }
  | { status: "unavailable"; reason: string };

/**
 * Build a BenchSyncClient from config. Returns a non-ok result (rather than
 * throwing) when the instance id or API key are missing/unresolved so the
 * caller can log once and skip wiring the handler.
 */
export async function resolveBenchSyncClient(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<BenchSyncClientSetupResult> {
  const env = params.env ?? process.env;
  const benchCloud = params.config.gateway?.benchCloud;
  const apiBaseUrl =
    benchCloud?.apiBaseUrl ??
    env.BENCH_CLOUD_API_BASE_URL ??
    env.BENCHAGI_API_BASE_URL ??
    DEFAULT_API_BASE_URL;
  const instanceId = benchCloud?.instanceId ?? env.BENCH_INSTANCE_ID;
  if (!instanceId || !instanceId.trim()) {
    return { status: "unavailable", reason: "gateway.benchCloud.instanceId is not set" };
  }

  const key = await resolveApiKey({ config: params.config, env });
  if (key.status === "unset") {
    return { status: "unavailable", reason: "gateway.benchCloud.apiKeyRef is not configured" };
  }
  if (key.status === "error") {
    return { status: "unavailable", reason: `apiKeyRef unresolved: ${key.reason}` };
  }

  const client = new BenchSyncClient({ apiBaseUrl, instanceId, apiKey: key.apiKey });
  return { status: "ok", client, instanceId, apiBaseUrl };
}
