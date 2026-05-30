import type { PluginRuntime } from "@benchagi/openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "@benchagi/openclaw/plugin-sdk/runtime-store";

const { setRuntime: setIMessageRuntime, getRuntime: getIMessageRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "imessage",
    errorMessage: "iMessage runtime not initialized",
  });
export { getIMessageRuntime, setIMessageRuntime };
