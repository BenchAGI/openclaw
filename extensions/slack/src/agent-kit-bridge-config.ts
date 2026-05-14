import type { SlackAgentKitBridgeConfig } from "./types.js";

export function defaultAgentKitBridgeConfig(): SlackAgentKitBridgeConfig {
  return {
    enabled: false,
    url: "",
    timeoutMs: 60000,
    mode: "runtime-adapter",
  };
}
