import type { PluginRuntime } from "@benchagi/openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "@benchagi/openclaw/plugin-sdk/runtime-store";

const { setRuntime: setQQBotRuntime, getRuntime: getQQBotRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "qqbot",
    errorMessage: "QQBot runtime not initialized",
  });
export { getQQBotRuntime, setQQBotRuntime };
