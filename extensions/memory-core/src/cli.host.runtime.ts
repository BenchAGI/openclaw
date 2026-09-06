// Memory Core plugin module implements cli.host behavior.
export {
  defaultRuntime,
  formatErrorMessage,
  getMemoryEmbeddingCommandSecretTargetIds,
  resolveCommandSecretRefsViaGateway,
  setVerbose,
  shortenHomeInString,
  shortenHomePath,
  theme,
  withManager,
  withProgress,
  withProgressTotals,
} from "openclaw/plugin-sdk/memory-core-host-runtime-cli";
export {
  buildTier1RetrievalContextFile,
  getRuntimeConfig,
  resolveDefaultAgentId,
  resolveMemorySearchConfig,
  resolveSessionTranscriptsDirForAgent,
  resolveStateDir,
  TIER1_FILE_NAME,
  type OpenClawConfig,
  type Tier1RetrievalOutcome,
} from "openclaw/plugin-sdk/memory-core-host-runtime-core";
export { getMemorySearchManager } from "./memory/index.js";
