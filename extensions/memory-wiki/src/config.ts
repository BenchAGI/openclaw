import os from "node:os";
import path from "node:path";
// agent-scope-runtime exports the same resolvers without memory-host-core's
// event-store/kysely graph, which doctor enumeration must not cold-load.
import {
  resolveDefaultAgentId,
  resolveSessionAgentIdStrict,
} from "openclaw/plugin-sdk/agent-scope-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { z } from "zod";
import type { OpenClawConfig } from "../api.js";

const WIKI_VAULT_MODES = ["isolated", "bridge", "unsafe-local"] as const;
const WIKI_VAULT_SCOPES = ["global", "agent"] as const;
const WIKI_RENDER_MODES = ["native", "obsidian"] as const;
export const WIKI_SEARCH_BACKENDS = ["shared", "local"] as const;
export const WIKI_SEARCH_CORPORA = ["wiki", "memory", "all"] as const;

type WikiVaultMode = (typeof WIKI_VAULT_MODES)[number];
type WikiVaultScope = (typeof WIKI_VAULT_SCOPES)[number];
type WikiRenderMode = (typeof WIKI_RENDER_MODES)[number];
export type WikiSearchBackend = (typeof WIKI_SEARCH_BACKENDS)[number];
export type WikiSearchCorpus = (typeof WIKI_SEARCH_CORPORA)[number];

export type MemoryWikiPluginConfig = z.infer<typeof MemoryWikiConfigSource>;

export type ResolvedMemoryWikiConfig = ReturnType<typeof resolveMemoryWikiConfig> & {
  agentId?: string;
};

export type MemoryWikiConfigResolver = (
  agentId?: string,
  appConfig?: OpenClawConfig,
) => ResolvedMemoryWikiConfig;

const DEFAULT_WIKI_VAULT_MODE: WikiVaultMode = "isolated";
const DEFAULT_WIKI_VAULT_SCOPE: WikiVaultScope = "global";
const DEFAULT_WIKI_RENDER_MODE: WikiRenderMode = "native";
const DEFAULT_WIKI_SEARCH_BACKEND: WikiSearchBackend = "shared";
const DEFAULT_WIKI_SEARCH_CORPUS: WikiSearchCorpus = "wiki";

export const MemoryWikiConfigSource = z
  .strictObject({
    vaultMode: z.enum(WIKI_VAULT_MODES).optional(),
    vault: z
      .strictObject({
        scope: z.enum(WIKI_VAULT_SCOPES).optional(),
        path: z.string().optional(),
        renderMode: z.enum(WIKI_RENDER_MODES).optional(),
      })
      .optional(),
    obsidian: z
      .strictObject({
        enabled: z.boolean().optional(),
        useOfficialCli: z.boolean().optional(),
        vaultName: z.string().optional(),
        openAfterWrites: z.boolean().optional(),
      })
      .optional(),
    bridge: z
      .strictObject({
        enabled: z.boolean().optional(),
        readMemoryArtifacts: z.boolean().optional(),
        indexDreamReports: z.boolean().optional(),
        indexDailyNotes: z.boolean().optional(),
        indexMemoryRoot: z.boolean().optional(),
        followMemoryEvents: z.boolean().optional(),
      })
      .optional(),
    unsafeLocal: z
      .strictObject({
        allowPrivateMemoryCoreAccess: z.boolean().optional(),
        paths: z.array(z.string()).optional(),
      })
      .optional(),
    ingest: z
      .strictObject({
        autoCompile: z.boolean().optional(),
        maxConcurrentJobs: z.number().int().min(1).optional(),
        allowUrlIngest: z.boolean().optional(),
      })
      .optional(),
    search: z
      .strictObject({
        backend: z.enum(WIKI_SEARCH_BACKENDS).optional(),
        corpus: z.enum(WIKI_SEARCH_CORPORA).optional(),
      })
      .optional(),
    context: z
      .strictObject({
        includeCompiledDigestPrompt: z.boolean().optional(),
      })
      .optional(),
    render: z
      .strictObject({
        preserveHumanBlocks: z.boolean().optional(),
        createBacklinks: z.boolean().optional(),
        createDashboards: z.boolean().optional(),
      })
      .optional(),
  })
  .superRefine((value, ctx) => {
    if (value.vault?.scope === "agent" && value.vaultMode === "unsafe-local") {
      ctx.addIssue({
        code: "custom",
        path: ["vaultMode"],
        message: "vaultMode=unsafe-local cannot be combined with vault.scope=agent",
      });
    }
    if (value.vault?.scope === "agent" && value.obsidian?.useOfficialCli === true) {
      ctx.addIssue({
        code: "custom",
        path: ["obsidian", "useOfficialCli"],
        message: "obsidian.useOfficialCli cannot be enabled with vault.scope=agent",
      });
    }
  });

function expandHomePath(inputPath: string, homedir: string): string {
  if (inputPath === "~") {
    return homedir;
  }
  if (inputPath.startsWith("~/")) {
    return path.join(homedir, inputPath.slice(2));
  }
  return inputPath;
}

/**
 * Instance IDs follow the openclaw.json schema constraint (see
 * `src/config/zod-schema.ts`): alphanumeric + underscore + hyphen, 1-128 chars.
 * Kept as a local copy here because the memory-wiki extension doesn't import
 * from `src/config/*` and the constraint is part of a path component that
 * must stay filesystem-safe regardless.
 */
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function normalizeInstanceId(value: string | undefined | null): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return INSTANCE_ID_PATTERN.test(value) ? value : undefined;
}

/** Bench fork: default global-scope vault, scoped by instanceId (invalid ids fall back to main). */
export function resolveDefaultMemoryWikiVaultPath(
  homedir = os.homedir(),
  instanceId?: string,
): string {
  const vaultName = normalizeInstanceId(instanceId) ?? "main";
  return path.join(homedir, ".openclaw", "wiki", vaultName);
}

export function resolveMemoryWikiConfig(
  config: MemoryWikiPluginConfig | undefined,
  options?: { homedir?: string; env?: NodeJS.ProcessEnv; instanceId?: string },
) {
  const homedir = options?.homedir ?? os.homedir();
  // Bench fork: the global-scope default vault is scoped by instanceId so two
  // OpenClaw instances on one machine never share ~/.openclaw/wiki/main.
  const instanceVaultName = normalizeInstanceId(options?.instanceId) ?? "main";
  const parsed = config ? MemoryWikiConfigSource.safeParse(config) : null;
  const safeConfig = parsed?.success ? parsed.data : (config ?? {});
  const vaultScope = safeConfig.vault?.scope ?? DEFAULT_WIKI_VAULT_SCOPE;
  const vaultPath =
    safeConfig.vault?.path ??
    path.join(
      resolveStateDir({ ...(options?.env ?? process.env), HOME: homedir }),
      "wiki",
      ...(vaultScope === "agent" ? [] : [instanceVaultName]),
    );

  return {
    vaultMode: safeConfig.vaultMode ?? DEFAULT_WIKI_VAULT_MODE,
    vault: {
      scope: vaultScope,
      path: expandHomePath(vaultPath, homedir),
      renderMode: safeConfig.vault?.renderMode ?? DEFAULT_WIKI_RENDER_MODE,
    },
    obsidian: {
      enabled: safeConfig.obsidian?.enabled ?? false,
      useOfficialCli: safeConfig.obsidian?.useOfficialCli ?? false,
      ...(safeConfig.obsidian?.vaultName ? { vaultName: safeConfig.obsidian.vaultName } : {}),
      openAfterWrites: safeConfig.obsidian?.openAfterWrites ?? false,
    },
    bridge: {
      enabled: safeConfig.bridge?.enabled ?? false,
      readMemoryArtifacts: safeConfig.bridge?.readMemoryArtifacts ?? true,
      indexDreamReports: safeConfig.bridge?.indexDreamReports ?? true,
      indexDailyNotes: safeConfig.bridge?.indexDailyNotes ?? true,
      indexMemoryRoot: safeConfig.bridge?.indexMemoryRoot ?? true,
      followMemoryEvents: safeConfig.bridge?.followMemoryEvents ?? true,
    },
    unsafeLocal: {
      allowPrivateMemoryCoreAccess: safeConfig.unsafeLocal?.allowPrivateMemoryCoreAccess ?? false,
      paths: safeConfig.unsafeLocal?.paths ?? [],
    },
    ingest: {
      autoCompile: safeConfig.ingest?.autoCompile ?? true,
      maxConcurrentJobs: safeConfig.ingest?.maxConcurrentJobs ?? 1,
      allowUrlIngest: safeConfig.ingest?.allowUrlIngest ?? true,
    },
    search: {
      backend: safeConfig.search?.backend ?? DEFAULT_WIKI_SEARCH_BACKEND,
      corpus: safeConfig.search?.corpus ?? DEFAULT_WIKI_SEARCH_CORPUS,
    },
    context: {
      includeCompiledDigestPrompt: safeConfig.context?.includeCompiledDigestPrompt ?? false,
    },
    render: {
      preserveHumanBlocks: safeConfig.render?.preserveHumanBlocks ?? true,
      createBacklinks: safeConfig.render?.createBacklinks ?? true,
      createDashboards: safeConfig.render?.createDashboards ?? true,
    },
  };
}

export function resolveMemoryWikiConfiguredAgentIds(
  appConfig: OpenClawConfig | undefined,
): string[] {
  const configuredIds = appConfig?.agents?.entries
    ? Object.keys(appConfig.agents.entries)
    : (appConfig?.agents?.list ?? []).map((entry) => entry.id);
  const ids = configuredIds.flatMap((entryId) => {
    const rawId = entryId.trim();
    if (!rawId) {
      return [];
    }
    return [resolveSessionAgentIdStrict({ config: appConfig, agentId: rawId })];
  });
  return [...new Set(ids.length > 0 ? ids : [resolveDefaultAgentId(appConfig ?? {})])];
}

/** Resolve the exact vault for one trusted runtime agent context. */
export function resolveMemoryWikiAgentConfig(params: {
  config: ResolvedMemoryWikiConfig;
  appConfig?: OpenClawConfig;
  agentId?: string;
}): ResolvedMemoryWikiConfig {
  if (params.config.vault.scope === "global") {
    return params.config;
  }
  if (params.config.vaultMode === "unsafe-local") {
    throw new Error("memory-wiki vault.scope=agent does not support vaultMode=unsafe-local.");
  }

  const configuredAgentIds = resolveMemoryWikiConfiguredAgentIds(params.appConfig);
  const requestedAgentId = params.agentId?.trim();
  if (!requestedAgentId && configuredAgentIds.length > 1) {
    throw new Error("agentId is required for memory-wiki when vault.scope=agent.");
  }
  const agentId = resolveSessionAgentIdStrict({
    config: params.appConfig,
    agentId: requestedAgentId ?? resolveDefaultAgentId(params.appConfig ?? {}),
  });
  if (!configuredAgentIds.includes(agentId)) {
    throw new Error(`Unknown memory-wiki agentId: ${requestedAgentId ?? agentId}.`);
  }

  return {
    ...params.config,
    agentId,
    vault: {
      ...params.config.vault,
      path: path.join(params.config.vault.path, agentId),
    },
  };
}
