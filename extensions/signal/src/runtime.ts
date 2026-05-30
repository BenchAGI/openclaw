import type { PluginRuntime } from "@benchagi/openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "@benchagi/openclaw/plugin-sdk/runtime-store";

const {
  setRuntime: setSignalRuntime,
  clearRuntime: clearSignalRuntime,
  getRuntime: getSignalRuntime,
} = createPluginRuntimeStore<PluginRuntime>({
  pluginId: "signal",
  errorMessage: "Signal runtime not initialized",
});
export { clearSignalRuntime, getSignalRuntime, setSignalRuntime };
