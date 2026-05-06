import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  BenchCloudBridgeConfig,
  BenchCloudCliTurnCreateResponse,
  BenchCloudCliTurnRequest,
} from "./bench-cloud-client.js";
import { createBenchCloudCliTurn } from "./bench-cloud-client.js";

type BenchCloudConfigSource = {
  enabled?: boolean;
  apiBaseUrl?: string;
  instanceId?: string;
  installId?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

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

function positiveInt(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveBenchCloudBridgeConfig(cfg: OpenClawConfig): BenchCloudBridgeConfig {
  const source = ((cfg as unknown as { gateway?: { benchCloud?: BenchCloudConfigSource } }).gateway
    ?.benchCloud ?? {}) as BenchCloudConfigSource;
  const enabled =
    source.enabled ??
    boolFromEnv(process.env.BENCH_CLOUD_BRIDGE_ENABLED) ??
    boolFromEnv(process.env.BENCH_CLI_REMOTE_BRAIN_BRIDGE_ENABLED) ??
    false;
  const apiBaseUrl =
    source.apiBaseUrl ??
    process.env.BENCH_CLOUD_API_BASE_URL ??
    process.env.BENCHAGI_API_BASE_URL ??
    "https://benchagi.com";
  const instanceId = source.instanceId ?? process.env.BENCH_INSTANCE_ID;
  const installId = source.installId ?? process.env.BENCH_INSTALL_ID;

  return {
    enabled,
    apiBaseUrl,
    instanceId,
    installId,
    pollIntervalMs: positiveInt(
      source.pollIntervalMs ?? process.env.BENCH_CLOUD_BRIDGE_POLL_INTERVAL_MS,
      1000,
    ),
    pollTimeoutMs: positiveInt(
      source.pollTimeoutMs ?? process.env.BENCH_CLOUD_BRIDGE_POLL_TIMEOUT_MS,
      5 * 60 * 1000,
    ),
  };
}

export function canAttemptBenchCloudBridge(params: {
  config: BenchCloudBridgeConfig;
  authToken?: string;
}): params is { config: BenchCloudBridgeConfig & { instanceId: string }; authToken: string } {
  return Boolean(params.config.enabled && params.config.instanceId && params.authToken);
}

export async function createCliRemoteBrainTurn(params: {
  config: BenchCloudBridgeConfig & { instanceId: string };
  authToken: string;
  request: Omit<BenchCloudCliTurnRequest, "instanceId" | "installId">;
  signal?: AbortSignal;
}): Promise<BenchCloudCliTurnCreateResponse> {
  return createBenchCloudCliTurn({
    config: params.config,
    authToken: params.authToken,
    signal: params.signal,
    body: {
      instanceId: params.config.instanceId,
      ...(params.config.installId ? { installId: params.config.installId } : {}),
      ...params.request,
    },
  });
}
