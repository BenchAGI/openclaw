import { definePluginEntry } from "./api.js";
import { memoryDurabilityConfigSchema, resolveMemoryDurabilityConfig } from "./src/config.js";
import { registerMemoryDurabilityWatcher } from "./src/scheduler.js";
import { createMemoryDurabilityTool } from "./src/tool.js";

// memory-durability — the OpenClaw-native, customer-shippable memory watchdog. Ships bundled (auto-loads
// at gateway startup on every install/upgrade). Exposes the `memory_durability` tool (deterministic,
// queryable verdict) and arms a managed cron watcher that alerts Slack on a break. Tenant-isolated by
// config. The deterministic checks are the shared twin of the operator-side Claude-harness watchdog.
export default definePluginEntry({
  id: "memory-durability",
  name: "Memory Durability",
  description:
    "Aurelius memory-plane durability watchdog: queryable health tool + Slack alarm on a break.",
  configSchema: memoryDurabilityConfigSchema,
  register(api) {
    const config = resolveMemoryDurabilityConfig(api.pluginConfig);
    // The tool is always available (queryable health), even if the watcher is off.
    api.registerTool(createMemoryDurabilityTool(config, api.config), { name: "memory_durability" });
    if (config.enabled) {
      registerMemoryDurabilityWatcher(api, config);
    }
  },
});
