import { getAgentRuntimeCommandSecretTargetIds } from "../cli/command-secret-targets.js";
import { getRuntimeConfig, readConfigFileSnapshotForWrite } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSecretRef } from "../config/types.secrets.js";
import type { RuntimeEnv } from "../runtime.js";

const TIER1_RERANKER_DEFAULT_TARGET_ID = "agents.defaults.memorySearch.query.reranker.apiKey";
const TIER1_RERANKER_AGENT_TARGET_ID = "agents.list[].memorySearch.query.reranker.apiKey";

type MemorySearchLike = {
  enabled?: boolean;
  query?: {
    tier1?: { enabled?: boolean };
    reranker?: { enabled?: boolean; apiKey?: unknown };
  };
};
type AgentRuntimeSecretAgent = {
  enabled?: boolean;
  memorySearch?: MemorySearchLike;
};
type Tier1RerankerSecretTargets = {
  targetIds: Set<string>;
  optionalActivePaths: Set<string>;
};

export async function resolveAgentRuntimeConfig(
  runtime: RuntimeEnv,
  params?: { runtimeTargetsChannelSecrets?: boolean },
): Promise<{
  loadedRaw: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  cfg: OpenClawConfig;
}> {
  const loadedRaw = getRuntimeConfig();
  const includeChannelTargets = params?.runtimeTargetsChannelSecrets === true;
  const tier1RerankerTargets = collectActiveTier1RerankerSecretTargets(loadedRaw);
  const hasRuntimeSecretRefs =
    hasAgentRuntimeSecretRefs({
      config: loadedRaw,
      includeChannelTargets,
    }) || Boolean(tier1RerankerTargets);
  const sourceConfig = await (async () => {
    try {
      const { snapshot } = await readConfigFileSnapshotForWrite();
      if (snapshot.valid) {
        return snapshot.resolved;
      }
    } catch {
      // Fall back to runtime-loaded config when source snapshot is unavailable.
    }
    return loadedRaw;
  })();
  const targetIds = getAgentRuntimeCommandSecretTargetIds({
    includeChannelTargets,
  });
  for (const targetId of tier1RerankerTargets?.targetIds ?? []) {
    targetIds.add(targetId);
  }
  const cfg = hasRuntimeSecretRefs
    ? (
        await (
          await import("../cli/command-config-resolution.runtime.js")
        ).resolveCommandConfigWithSecrets({
          config: loadedRaw,
          commandName: "agent",
          targetIds,
          ...(tier1RerankerTargets
            ? { optionalActivePaths: tier1RerankerTargets.optionalActivePaths }
            : {}),
          runtime,
        })
      ).resolvedConfig
    : loadedRaw;
  setRuntimeConfigSnapshot(cfg, sourceConfig);
  return { loadedRaw, sourceConfig, cfg };
}

function hasNestedSecretRef(value: unknown): boolean {
  if (isSecretRef(value)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((entry) => hasNestedSecretRef(entry));
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  return Object.values(value).some((entry) => hasNestedSecretRef(entry));
}

function hasAgentRuntimeSecretRefs(params: {
  config: OpenClawConfig;
  includeChannelTargets: boolean;
}): boolean {
  const { config } = params;
  if (hasNestedSecretRef(config.models?.providers)) {
    return true;
  }
  if (hasNestedSecretRef(config.agents?.defaults?.memorySearch?.remote?.apiKey)) {
    return true;
  }
  if (
    Array.isArray(config.agents?.list) &&
    config.agents.list.some((agent) => hasNestedSecretRef(agent?.memorySearch?.remote?.apiKey))
  ) {
    return true;
  }
  if (hasNestedSecretRef(config.messages?.tts?.providers)) {
    return true;
  }
  if (hasNestedSecretRef(config.skills?.entries)) {
    return true;
  }
  if (hasNestedSecretRef(config.tools?.web?.search)) {
    return true;
  }
  if (
    config.plugins?.entries &&
    Object.values(config.plugins.entries).some((entry) =>
      hasNestedSecretRef({
        webSearch: entry?.config?.webSearch,
        webFetch: entry?.config?.webFetch,
      }),
    )
  ) {
    return true;
  }
  return params.includeChannelTargets ? hasNestedSecretRef(config.channels) : false;
}

function collectActiveTier1RerankerSecretTargets(
  config: OpenClawConfig,
): Tier1RerankerSecretTargets | undefined {
  const optionalActivePaths = new Set<string>();
  const targetIds = new Set<string>();
  const defaultsMemorySearch = config.agents?.defaults?.memorySearch as
    | MemorySearchLike
    | undefined;
  const defaultsReranker = resolveMemorySearchReranker(defaultsMemorySearch);
  const agents = (config.agents?.list ?? []) as AgentRuntimeSecretAgent[];
  if (
    hasNestedSecretRef(defaultsReranker?.apiKey) &&
    defaultRerankerSecretRefIsActive(defaultsMemorySearch, agents)
  ) {
    optionalActivePaths.add(TIER1_RERANKER_DEFAULT_TARGET_ID);
    targetIds.add(TIER1_RERANKER_DEFAULT_TARGET_ID);
  }

  agents.forEach((agent, index) => {
    const memorySearch = agent.memorySearch;
    const reranker = resolveMemorySearchReranker(memorySearch);
    if (
      !hasNestedSecretRef(reranker?.apiKey) ||
      !agentRerankerSecretRefIsActive(agent, defaultsMemorySearch)
    ) {
      return;
    }
    optionalActivePaths.add(`agents.list.${index}.memorySearch.query.reranker.apiKey`);
    targetIds.add(TIER1_RERANKER_AGENT_TARGET_ID);
  });

  if (optionalActivePaths.size === 0) {
    return undefined;
  }
  return { targetIds, optionalActivePaths };
}

function defaultRerankerSecretRefIsActive(
  defaultsMemorySearch: MemorySearchLike | undefined,
  agents: readonly AgentRuntimeSecretAgent[],
): boolean {
  if (agents.length === 0) {
    return (
      resolveEffectiveMemorySearchEnabled(defaultsMemorySearch, undefined) &&
      tier1AndRerankerAreEnabled(defaultsMemorySearch, undefined)
    );
  }
  return agents.some((agent) => {
    if (
      agent.enabled === false ||
      !resolveEffectiveMemorySearchEnabled(agent.memorySearch, defaultsMemorySearch)
    ) {
      return false;
    }
    return (
      tier1AndRerankerAreEnabled(agent.memorySearch, defaultsMemorySearch) &&
      !hasOwnApiKey(resolveMemorySearchReranker(agent.memorySearch))
    );
  });
}

function agentRerankerSecretRefIsActive(
  agent: AgentRuntimeSecretAgent,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return (
    agent.enabled !== false &&
    resolveEffectiveMemorySearchEnabled(agent.memorySearch, defaultsMemorySearch) &&
    tier1AndRerankerAreEnabled(agent.memorySearch, defaultsMemorySearch)
  );
}

function tier1AndRerankerAreEnabled(
  memorySearch: MemorySearchLike | undefined,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return (
    resolveEffectiveTier1Enabled(memorySearch, defaultsMemorySearch) &&
    resolveEffectiveRerankerEnabled(memorySearch, defaultsMemorySearch)
  );
}

function resolveEffectiveMemorySearchEnabled(
  memorySearch: MemorySearchLike | undefined,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return memorySearch?.enabled ?? defaultsMemorySearch?.enabled ?? true;
}

function resolveEffectiveTier1Enabled(
  memorySearch: MemorySearchLike | undefined,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return (
    memorySearch?.query?.tier1?.enabled ?? defaultsMemorySearch?.query?.tier1?.enabled ?? false
  );
}

function resolveEffectiveRerankerEnabled(
  memorySearch: MemorySearchLike | undefined,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return (
    memorySearch?.query?.reranker?.enabled ??
    defaultsMemorySearch?.query?.reranker?.enabled ??
    false
  );
}

function resolveMemorySearchReranker(
  memorySearch: MemorySearchLike | undefined,
): { enabled?: boolean; apiKey?: unknown } | undefined {
  return memorySearch?.query?.reranker;
}

function hasOwnApiKey(value: { apiKey?: unknown } | undefined): boolean {
  return Boolean(value && Object.hasOwn(value, "apiKey"));
}
