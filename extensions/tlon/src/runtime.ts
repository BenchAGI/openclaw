import type { PluginRuntime } from "@benchagi/openclaw/plugin-sdk/plugin-runtime";
import { createPluginRuntimeStore } from "@benchagi/openclaw/plugin-sdk/runtime-store";

const { setRuntime: setTlonRuntime, getRuntime: getTlonRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "tlon",
    errorMessage: "Tlon runtime not initialized",
  });
export { getTlonRuntime, setTlonRuntime };
