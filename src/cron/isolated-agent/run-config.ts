/** Builds isolated cron runner config from global defaults plus agent overrides. */
import type { resolveAgentConfig } from "../../agents/agent-scope.js";
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  selectApplicableRuntimeConfig,
} from "../../config/config.js";
import type { AgentDefaultsConfig } from "../../config/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type ResolvedAgentConfig = NonNullable<ReturnType<typeof resolveAgentConfig>>;

/** Selects the active reloadable config when it descends from the cron caller's snapshot. */
export function resolveCronActiveRuntimeConfig(cfg: OpenClawConfig): OpenClawConfig {
  const runtimeConfig = getRuntimeConfigSnapshot();
  const runtimeSourceConfig = getRuntimeConfigSourceSnapshot();
  if (!runtimeConfig || !runtimeSourceConfig) {
    return cfg;
  }
  return (
    selectApplicableRuntimeConfig({ inputConfig: cfg, runtimeConfig, runtimeSourceConfig }) ?? cfg
  );
}

function extractCronAgentDefaultsOverride(agentConfigOverride?: ResolvedAgentConfig) {
  const {
    model: overrideModel,
    models: overrideModels,
    sandbox: _agentSandboxOverride,
    memory: _agentMemoryOverride,
    ...agentOverrideRest
  } = agentConfigOverride ?? {};
  return {
    overrideModel,
    overrideModels,
    definedOverrides: Object.fromEntries(
      Object.entries(agentOverrideRest).filter(([, value]) => value !== undefined),
    ) as Partial<AgentDefaultsConfig>,
  };
}

function mergeCronAgentModelOverride(params: {
  defaults: AgentDefaultsConfig;
  overrideModel: ResolvedAgentConfig["model"] | undefined;
  overrideModels: ResolvedAgentConfig["models"] | undefined;
}) {
  const nextDefaults: AgentDefaultsConfig = { ...params.defaults };
  const existingModel =
    nextDefaults.model && typeof nextDefaults.model === "object" ? nextDefaults.model : {};
  if (typeof params.overrideModel === "string") {
    nextDefaults.model = { ...existingModel, primary: params.overrideModel };
  } else if (params.overrideModel) {
    nextDefaults.model = { ...existingModel, ...params.overrideModel };
  }
  if (params.overrideModels) {
    nextDefaults.models = { ...nextDefaults.models, ...params.overrideModels };
  }
  return nextDefaults;
}

/** Selects the active runtime snapshot before deriving isolated cron agent defaults. */
export function resolveCronAgentConfig(params: {
  config: OpenClawConfig;
  agentConfigOverride?: ResolvedAgentConfig;
}) {
  const runtimeConfig = resolveCronActiveRuntimeConfig(params.config);
  const { overrideModel, overrideModels, definedOverrides } = extractCronAgentDefaultsOverride(
    params.agentConfigOverride,
  );
  // Keep nested configs owned by agent-aware resolvers out of this flattened snapshot.
  // Copying partial sandbox or memory objects into defaults destroys their global fields,
  // and replacing the per-model `models` map drops global runtime rows (e.g. `anthropic/*`
  // -> claude-cli) that the agent entry never mentioned; merge those per model id instead.
  const agentDefaults = mergeCronAgentModelOverride({
    defaults: Object.assign({}, runtimeConfig.agents?.defaults, definedOverrides),
    overrideModel,
    overrideModels,
  });
  return {
    runtimeConfig,
    agentDefaults,
    cfgWithAgentDefaults: {
      ...runtimeConfig,
      agents: Object.assign({}, runtimeConfig.agents, { defaults: agentDefaults }),
    } satisfies OpenClawConfig,
  };
}
