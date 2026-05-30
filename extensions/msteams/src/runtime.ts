import { createPluginRuntimeStore } from "@benchagi/openclaw/plugin-sdk/runtime-store";
import type { PluginRuntime } from "@benchagi/openclaw/plugin-sdk/runtime-store";

const { setRuntime: setMSTeamsRuntime, getRuntime: getMSTeamsRuntime } =
  createPluginRuntimeStore<PluginRuntime>({
    pluginId: "msteams",
    errorMessage: "MSTeams runtime not initialized",
  });
export { getMSTeamsRuntime, setMSTeamsRuntime };
