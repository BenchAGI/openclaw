import type { OpenClawConfig } from "@benchagi/openclaw/plugin-sdk/browser-config-runtime";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
} from "@benchagi/openclaw/plugin-sdk/browser-config-runtime";

export function isDefaultBrowserPluginEnabled(cfg: OpenClawConfig): boolean {
  return resolveEffectiveEnableState({
    id: "browser",
    origin: "bundled",
    config: normalizePluginsConfig(cfg.plugins),
    rootConfig: cfg,
    enabledByDefault: true,
  }).enabled;
}
