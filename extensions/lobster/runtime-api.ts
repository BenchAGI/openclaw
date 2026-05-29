export { definePluginEntry } from "@benchagi/openclaw/plugin-sdk/core";
export type {
  AnyAgentTool,
  OpenClawPluginApi,
  OpenClawPluginToolContext,
  OpenClawPluginToolFactory,
} from "@benchagi/openclaw/plugin-sdk/core";
export {
  applyWindowsSpawnProgramPolicy,
  materializeWindowsSpawnProgram,
  resolveWindowsSpawnProgramCandidate,
} from "@benchagi/openclaw/plugin-sdk/windows-spawn";
