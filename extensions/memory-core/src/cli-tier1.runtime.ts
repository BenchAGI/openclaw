// Memory Core plugin module implements the Bench fork's Tier-1 retrieval CLI and
// external-file promotion (fork #63 / #70). Split out of cli.runtime.ts when
// upstream 2026.9.2 turned that file into a barrel.
import fs from "node:fs/promises";
import path from "node:path";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import {
  emitMemorySecretResolveDiagnostics,
  resolveMemoryAgent,
  withMemoryManagerForAgent,
} from "./cli-runtime-common.js";
import {
  buildTier1RetrievalContextFile,
  defaultRuntime,
  formatErrorMessage,
  getMemoryEmbeddingCommandSecretTargetIds,
  getRuntimeConfig,
  resolveCommandSecretRefsViaGateway,
  resolveMemorySearchConfig,
  setVerbose,
  shortenHomePath,
  theme,
  TIER1_FILE_NAME,
  type OpenClawConfig,
  type Tier1RetrievalOutcome,
} from "./cli.host.runtime.js";
import type { MemoryPromoteFileOptions, MemoryTier1CommandOptions } from "./cli.types.js";
import {
  promoteFileToAgentMemory,
  type PromoteFileSource,
  type PromoteFileSummary,
} from "./promote-file.js";

type MemorySearchLike = {
  enabled?: boolean;
  query?: {
    tier1?: { enabled?: boolean };
    reranker?: { enabled?: boolean; apiKey?: unknown };
  };
};
type AgentMemorySearchLike = {
  enabled?: boolean;
  memory?: { search?: MemorySearchLike };
};

const TIER1_RERANKER_DEFAULT_TARGET_ID = "memory.search.query.reranker.apiKey";
const TIER1_RERANKER_AGENT_TARGET_ID = "agents.entries.*.memory.search.query.reranker.apiKey";

function getActiveTier1RerankerSecretTargets(
  cfg: OpenClawConfig,
): { targetIds: Set<string>; optionalActivePaths: Set<string> } | undefined {
  const defaultsMemorySearch = cfg.memory?.search as MemorySearchLike | undefined;
  const defaultsReranker = resolveMemorySearchReranker(defaultsMemorySearch);
  const agentsConfig = cfg.agents as
    | { list?: AgentMemorySearchLike[]; entries?: Record<string, AgentMemorySearchLike> }
    | undefined;
  const agentPaths: Array<{ agent: AgentMemorySearchLike; path: string }> = [
    ...Object.entries(agentsConfig?.entries ?? {}).map(([key, agent]) => ({
      agent,
      path: `agents.entries.${key}`,
    })),
    ...(agentsConfig?.list ?? []).map((agent, index) => ({ agent, path: `agents.list.${index}` })),
  ];
  const agents = agentPaths.map((entry) => entry.agent);
  const targetIds = new Set<string>();
  const optionalActivePaths = new Set<string>();

  if (
    isSecretRefValue(defaultsReranker?.apiKey) &&
    defaultRerankerSecretRefIsActive(defaultsMemorySearch, agents)
  ) {
    targetIds.add(TIER1_RERANKER_DEFAULT_TARGET_ID);
    optionalActivePaths.add(TIER1_RERANKER_DEFAULT_TARGET_ID);
  }

  agentPaths.forEach(({ agent, path: agentPath }) => {
    const memorySearch = agent.memory?.search;
    const reranker = resolveMemorySearchReranker(memorySearch);
    if (
      !isSecretRefValue(reranker?.apiKey) ||
      !agentRerankerSecretRefIsActive(agent, defaultsMemorySearch)
    ) {
      return;
    }
    targetIds.add(TIER1_RERANKER_AGENT_TARGET_ID);
    optionalActivePaths.add(`${agentPath}.memory.search.query.reranker.apiKey`);
  });

  if (optionalActivePaths.size === 0) {
    return undefined;
  }
  return { targetIds, optionalActivePaths };
}

function defaultRerankerSecretRefIsActive(
  defaultsMemorySearch: MemorySearchLike | undefined,
  agents: readonly AgentMemorySearchLike[],
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
      !resolveEffectiveMemorySearchEnabled(agent.memory?.search, defaultsMemorySearch)
    ) {
      return false;
    }
    return (
      tier1AndRerankerAreEnabled(agent.memory?.search, defaultsMemorySearch) &&
      !hasOwnApiKey(resolveMemorySearchReranker(agent.memory?.search))
    );
  });
}

function agentRerankerSecretRefIsActive(
  agent: AgentMemorySearchLike,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return (
    agent.enabled !== false &&
    resolveEffectiveMemorySearchEnabled(agent.memory?.search, defaultsMemorySearch) &&
    tier1AndRerankerAreEnabled(agent.memory?.search, defaultsMemorySearch)
  );
}

function tier1AndRerankerAreEnabled(
  memorySearch: MemorySearchLike | undefined,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return (
    (memorySearch?.query?.tier1?.enabled ?? defaultsMemorySearch?.query?.tier1?.enabled ?? false) &&
    (memorySearch?.query?.reranker?.enabled ??
      defaultsMemorySearch?.query?.reranker?.enabled ??
      false)
  );
}

function resolveEffectiveMemorySearchEnabled(
  memorySearch: MemorySearchLike | undefined,
  defaultsMemorySearch: MemorySearchLike | undefined,
): boolean {
  return memorySearch?.enabled ?? defaultsMemorySearch?.enabled ?? true;
}

function resolveMemorySearchReranker(
  memorySearch: MemorySearchLike | undefined,
): { enabled?: boolean; apiKey?: unknown } | undefined {
  return memorySearch?.query?.reranker;
}

function hasOwnApiKey(value: { apiKey?: unknown } | undefined): boolean {
  return Boolean(value && Object.hasOwn(value, "apiKey"));
}

function isSecretRefValue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    (record.source === "env" || record.source === "file" || record.source === "exec") &&
    typeof record.provider === "string" &&
    typeof record.id === "string"
  );
}

async function loadTier1CommandConfig(
  commandName: string,
  options?: { includeTier1Reranker?: boolean },
): Promise<{ config: OpenClawConfig; diagnostics: string[] }> {
  const config = getRuntimeConfig({ skipPluginValidation: true });
  const tier1RerankerTargets =
    options?.includeTier1Reranker === true
      ? getActiveTier1RerankerSecretTargets(config)
      : undefined;
  const targetIds = getMemoryEmbeddingCommandSecretTargetIds();
  for (const targetId of tier1RerankerTargets?.targetIds ?? []) {
    targetIds.add(targetId);
  }
  const { resolvedConfig, diagnostics } = await resolveCommandSecretRefsViaGateway({
    config,
    commandName,
    targetIds,
    ...(tier1RerankerTargets
      ? { optionalActivePaths: tier1RerankerTargets.optionalActivePaths }
      : {}),
  });
  return { config: resolvedConfig, diagnostics };
}

function buildCliMemoryTier1SessionKey(agentId: string): string {
  return buildAgentSessionKey({
    agentId,
    channel: "cli",
    peer: { kind: "direct", id: "memory-tier1" },
    dmScope: "per-channel-peer",
  });
}

async function resolvePromoteFileInputs(opts: MemoryPromoteFileOptions): Promise<string[]> {
  const out: string[] = [];
  if (opts.source) {
    const resolved = path.resolve(opts.source);
    const stat = await fs.stat(resolved).catch(() => null);
    if (stat?.isFile()) {
      out.push(resolved);
    }
  }
  if (opts.fromDir) {
    const dir = path.resolve(opts.fromDir);
    const stat = await fs.stat(dir).catch(() => null);
    if (stat?.isDirectory()) {
      const rels = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[]);
      for (const rel of rels) {
        if (!rel.toLowerCase().endsWith(".md")) {
          continue;
        }
        const full = path.join(dir, rel);
        // Never re-ingest our own promoted output.
        if (full.includes(`${path.sep}memory${path.sep}seat${path.sep}`)) {
          continue;
        }
        const entryStat = await fs.stat(full).catch(() => null);
        if (entryStat?.isFile()) {
          out.push(full);
        }
      }
    }
  }
  return [...new Set(out)].toSorted((a, b) => a.localeCompare(b));
}

async function promoteInputsForAgent(
  cfg: OpenClawConfig,
  agentId: string,
  inputs: string[],
  opts: MemoryPromoteFileOptions,
): Promise<PromoteFileSummary | null> {
  let result: PromoteFileSummary | null = null;
  await withMemoryManagerForAgent({
    commandName: "memory promote-file",
    cfg,
    agentId,
    purpose: "status",
    run: async (manager) => {
      try {
        const sources: PromoteFileSource[] = [];
        for (const file of inputs) {
          const content = await fs.readFile(file, "utf8").catch(() => null);
          if (content == null) {
            continue;
          }
          sources.push({
            sourcePath: file,
            content,
            memoryType: opts.type,
            sourceSessionId: opts.session,
            sourceLabel: opts.sourceLabel ?? "claude-code-seat",
            sourceAgentId: opts.sourceAgent ?? agentId,
            seatKind: opts.seatKind,
          });
        }
        result = await promoteFileToAgentMemory({
          manager,
          sources,
          force: Boolean(opts.force),
        });
      } catch (err) {
        defaultRuntime.error(`Memory promote-file failed (${agentId}): ${formatErrorMessage(err)}`);
        process.exitCode = 1;
      }
    },
  });
  return result;
}

export async function runMemoryPromoteFile(opts: MemoryPromoteFileOptions) {
  setVerbose(Boolean(opts.verbose));
  const { config: cfg, diagnostics } = await loadTier1CommandConfig("memory promote-file");
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentId = resolveMemoryAgent(cfg, opts.agent);

  const inputs = await resolvePromoteFileInputs(opts);
  if (inputs.length === 0) {
    defaultRuntime.error(
      "memory promote-file: no input files (use --source <file> or --from-dir <dir>).",
    );
    process.exitCode = 1;
    return;
  }

  const summary = await promoteInputsForAgent(cfg, agentId, inputs, opts);
  if (!summary) {
    return;
  }
  if (opts.json) {
    defaultRuntime.writeJson({
      agent: agentId,
      workspaceDir: shortenHomePath(summary.workspaceDir),
      indexed: summary.indexed,
      results: summary.results.map((r) => ({ ...r, target: shortenHomePath(r.target) })),
    });
  } else {
    for (const r of summary.results) {
      defaultRuntime.log(`${r.status}\t${shortenHomePath(r.target)}`);
    }
    defaultRuntime.log(
      summary.indexed
        ? `Memory promote-file indexed (${agentId}).`
        : `Memory promote-file: nothing to reindex (${agentId}).`,
    );
  }
}

export async function runMemoryTier1(
  queryArg: string | undefined,
  opts: MemoryTier1CommandOptions,
) {
  const query = (opts.query ?? queryArg)?.trim();
  if (!query) {
    defaultRuntime.error(
      "Missing retrieval query. Provide a positional query or use --query <text>.",
    );
    process.exitCode = 1;
    return;
  }
  const { config: cfg, diagnostics } = await loadTier1CommandConfig("memory tier1", {
    includeTier1Reranker: true,
  });
  emitMemorySecretResolveDiagnostics(diagnostics, { json: Boolean(opts.json) });
  const agentId = resolveMemoryAgent(cfg, opts.agent);
  const sessionKey = opts.sessionKey?.trim() || buildCliMemoryTier1SessionKey(agentId);

  const emit = async (outcome: Tier1RetrievalOutcome) => {
    const body = outcome.injected ? (outcome.file?.content ?? null) : null;
    if (opts.json) {
      defaultRuntime.writeJson({
        injected: outcome.injected,
        fileName: TIER1_FILE_NAME,
        body,
        diag: outcome.diag,
      });
      return;
    }
    if (opts.out) {
      if (body !== null) {
        const outPath = path.resolve(opts.out);
        await fs.writeFile(outPath, body, "utf-8");
        defaultRuntime.log(
          `Tier-1 context written to ${shortenHomePath(outPath)} (${outcome.diag.injectedHits} hits, ${Buffer.byteLength(body, "utf8")} bytes).`,
        );
      } else {
        defaultRuntime.log(`Tier-1 context not injected (${outcome.diag.reason}).`);
      }
      return;
    }
    if (body !== null) {
      defaultRuntime.log(body);
    }
  };

  const params = {
    config: cfg,
    agentId,
    promptText: query,
    sessionKey,
    effectiveWorkspace: process.cwd(),
    warn: (message: string) => defaultRuntime.error(theme.warn(message)),
    ...(opts.maxResults !== undefined ? { maxResultsOverride: opts.maxResults } : {}),
    ...(opts.maxBytes !== undefined ? { maxBytesOverride: opts.maxBytes } : {}),
  };

  // Honor the runners' flag gate before opening a memory manager: when Tier-1 is
  // disabled (or memory search is off entirely), buildTier1RetrievalContextFile
  // resolves "disabled" without searching — no manager required. Fail-open contract:
  // every retrieval miss exits 0; only usage errors set a non-zero exit code.
  let tier1Enabled = false;
  try {
    tier1Enabled = resolveMemorySearchConfig(cfg, agentId)?.query.tier1.enabled === true;
  } catch {
    // Treat unresolvable config as disabled; the build call below reports it.
  }
  if (!tier1Enabled) {
    await emit(await buildTier1RetrievalContextFile({ ...params, searchFn: async () => [] }));
    return;
  }

  await withMemoryManagerForAgent({
    commandName: "memory tier1",
    cfg,
    agentId,
    purpose: "cli",
    run: async (manager) => {
      const outcome = await buildTier1RetrievalContextFile({
        ...params,
        // Scope to curated memory only, mirroring the runners' default search path.
        searchFn: (q, searchOpts) => manager.search(q, { ...searchOpts, sources: ["memory"] }),
      });
      await emit(outcome);
    },
  });
}
