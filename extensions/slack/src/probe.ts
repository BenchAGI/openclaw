import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import type { SlackAgentKitBridgeConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-runtime";
import { createSlackWebClient } from "./client.js";
import { createAgentKitBridgeClient } from "./monitor/agent-kit-bridge.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
  bridgeStatus?: "ok" | "unreachable" | "disabled" | "unknown";
  bridgeError?: string;
  bridgeVersion?: string;
  bridgeElapsedMs?: number;
};

async function probeAgentKitBridge(
  bridgeConfig: SlackAgentKitBridgeConfig | undefined,
): Promise<Pick<SlackProbe, "bridgeStatus" | "bridgeError" | "bridgeVersion" | "bridgeElapsedMs">> {
  if (!bridgeConfig) {
    return { bridgeStatus: "disabled" };
  }
  if (!bridgeConfig.enabled) {
    return { bridgeStatus: "disabled" };
  }
  const client = createAgentKitBridgeClient({
    ...bridgeConfig,
    timeoutMs: Math.min(bridgeConfig.timeoutMs ?? 60000, 2000),
  });
  const result = await client.healthz();
  if ("disabled" in result) {
    return { bridgeStatus: "disabled", bridgeElapsedMs: result.latency_ms };
  }
  if (result.ok) {
    return {
      bridgeStatus: "ok",
      bridgeVersion: result.version,
      bridgeElapsedMs: result.latency_ms,
    };
  }
  return {
    bridgeStatus: "unreachable",
    bridgeError: result.error.message,
    bridgeElapsedMs: result.error.latency_ms,
  };
}

export async function probeSlack(
  token: string,
  timeoutMs = 2500,
  bridgeConfig?: SlackAgentKitBridgeConfig,
): Promise<SlackProbe> {
  const client = createSlackWebClient(token);
  const start = Date.now();
  const bridge = await probeAgentKitBridge(bridgeConfig);
  try {
    const result = await withTimeout(client.auth.test(), timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        status: 200,
        error: result.error ?? "unknown",
        elapsedMs: Date.now() - start,
        ...bridge,
      };
    }
    return {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - start,
      bot: { id: result.user_id, name: result.user },
      team: { id: result.team_id, name: result.team },
      ...bridge,
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    const status =
      typeof (err as { status?: number }).status === "number"
        ? (err as { status?: number }).status
        : null;
    return {
      ok: false,
      status,
      error: message,
      elapsedMs: Date.now() - start,
      ...bridge,
    };
  }
}
