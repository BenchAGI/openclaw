import fs from "node:fs/promises";
import path from "node:path";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { McpLoopbackRequestContext } from "../../gateway/mcp-grant-store.js";
import { handleMcpJsonRpc } from "../../gateway/mcp-http.handlers.js";
import * as loopbackTools from "../../gateway/mcp-http.runtime.js";
import { buildMcpToolSchema } from "../../gateway/mcp-http.schema.js";
import { resolvePluginSubagentToolsAlsoAllow } from "../../gateway/server-plugin-runtime-client.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createNamedToolEntry,
  createToolRegistry,
} from "../../plugins/tools.optional.test-helpers.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { disposeAllSessionMcpRuntimes } from "../agent-bundle-mcp-manager-api.js";
import { bindSessionMcpRuntimeTestScheduler } from "../agent-bundle-mcp-manager.test-support.js";
import { testing as cliBackendsTesting } from "../cli-backends.test-support.js";
import {
  createTestMcpLoopbackClientGrant,
  createTestMcpLoopbackServer,
  createTestMcpLoopbackServerConfig,
} from "../cli-runner.test-helpers.js";
import { requireMcpConfigPath } from "../cli-runner/bundle-mcp.test-support.js";
import "../cli-runner/prepare.runtime.js";
import {
  resetCliRunnerPrepareTestDeps,
  setCliRunnerPrepareTestDeps,
} from "../cli-runner/prepare.test-support.js";
import type { PreparedCliRunContext } from "../cli-runner/types.js";
import * as mcpTransport from "../mcp-transport.js";
import type { AnyAgentTool } from "../tools/common.js";
import {
  makeRunAgentAttemptParams,
  makeSessionEntry,
} from "./attempt-execution.cli.test-support.js";
import { runAgentAttempt } from "./attempt-execution.js";

const executePreparedCliRun = vi.hoisted(() => vi.fn());
// mock-isolation: Capture the serialized CLI input without starting a provider process.
vi.mock("../cli-runner/execute.runtime.js", () => ({ executePreparedCliRun }));

describe("CLI attempt session MCP overrides", () => {
  let root: string;
  const servers: Server[] = [];
  let overlays: Array<Record<string, unknown>>;

  function useCliBackend(selectable = false) {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: () => undefined,
      resolveRuntimeCliBackends: () => [
        {
          id: "claude-cli",
          modelProvider: "anthropic",
          pluginId: "anthropic",
          bundleMcp: true,
          bundleMcpMode: "claude-config-file",
          ...(selectable
            ? {
                nativeToolMode: "selectable" as const,
                toolAvailabilityEnforcement: "execution-args" as const,
                resolveExecutionArgs: ({ baseArgs }: { baseArgs: readonly string[] }) => baseArgs,
              }
            : {}),
          config: {
            command: "claude",
            args: ["--print"],
            output: "text",
            input: "arg",
            sessionMode: "none",
          },
        },
      ],
    });
  }

  const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
    afterAll(async () => {
      try {
        await cleanupSessionStateForTest({ stateDir: root });
        cleanup();
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  beforeAll(() => {
    root = tempDirs.make("openclaw-cli-session-mcp-");
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    vi.stubEnv("HOME", root);
  });

  afterEach(async () => {
    await disposeAllSessionMcpRuntimes();
    await Promise.all(servers.splice(0).map((server) => server.close()));
    resetCliRunnerPrepareTestDeps();
    cliBackendsTesting.resetDepsForTest();
    setCurrentPluginMetadataSnapshot(undefined);
    clearRuntimeConfigSnapshot();
    vi.restoreAllMocks();
  });

  it.each([
    { granted: false, selectable: true, denied: false, policy: "coding" },
    { granted: true, selectable: false, denied: false, policy: "coding" },
    { granted: true, selectable: true, denied: false, policy: "coding" },
    { granted: true, selectable: true, denied: true, policy: "coding" },
    { granted: false, selectable: true, denied: false, policy: "unrestricted" },
    { granted: true, selectable: true, denied: false, policy: "unrestricted" },
    { granted: true, selectable: true, denied: false, policy: "explicit" },
  ] as const)(
    "carries grant=$granted through selectable=$selectable CLI/MCP with $policy policy and deny=$denied",
    async ({ granted, selectable, denied, policy }) => {
      useCliBackend(selectable);
      const available = granted && !denied && policy !== "explicit";
      const pluginId = "worker-owner";
      const toolName = "worker_finish";
      const invoked: string[] = [];
      const registry = createToolRegistry([
        createNamedToolEntry(pluginId, [toolName, "worker_ungranted"], {
          optional: true,
          source: "/tmp/worker-owner/index.js",
          factory: (ctx) =>
            [toolName, "worker_ungranted"].map((name) => ({
              name,
              description: "Finish an owner-scoped worker fixture.",
              parameters: { type: "object", properties: {} },
              execute: async () => {
                invoked.push(name);
                return {
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify({
                        agentId: (ctx as { agentId: string }).agentId,
                        finished: true,
                      }),
                    },
                  ],
                };
              },
            })),
        }),
        createNamedToolEntry("default-owner", "default_tool", {
          source: "/tmp/default-owner/index.js",
        }),
      ]);
      const cfg: OpenClawConfig = {
        agents: { defaults: { workspace: root, skipBootstrap: true } },
        plugins: {
          allow: [pluginId, "default-owner"],
          entries: { [pluginId]: { enabled: true }, "default-owner": { enabled: true } },
          slots: { memory: "none" },
        },
        tools:
          policy === "explicit"
            ? { allow: ["read"] }
            : policy === "unrestricted"
              ? {}
              : { profile: policy, ...(denied ? { deny: [toolName] } : {}) },
        skills: { load: { watch: false } },
      };
      const metadata = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: pluginId,
            source: "/tmp/worker-owner/index.js",
            rootDir: "/tmp/worker-owner",
            enabledByDefault: true,
            contracts: { tools: [toolName, "worker_ungranted"] },
            toolMetadata: { [toolName]: { optional: true }, worker_ungranted: { optional: true } },
          },
          {
            id: "default-owner",
            source: "/tmp/default-owner/index.js",
            rootDir: "/tmp/default-owner",
            enabledByDefault: true,
            contracts: { tools: ["default_tool"] },
          },
        ],
      });
      metadata.policyHash = resolveInstalledPluginIndexPolicyHash(cfg);
      metadata.index.policyHash = metadata.policyHash;
      metadata.workspaceDir = root;
      setCurrentPluginMetadataSnapshot(metadata, { config: cfg, workspaceDir: root });
      setRuntimeConfigSnapshot(cfg);
      setActivePluginRegistry(registry as never, "cli-plugin-tools", "gateway-bindable", root);
      const runtimePluginToolGrant = granted
        ? resolvePluginSubagentToolsAlsoAllow({ pluginId, toolsAlsoAllow: [toolName] })
        : undefined;
      let captured: McpLoopbackRequestContext | undefined;
      let retainedTool: AnyAgentTool | undefined;
      setCliRunnerPrepareTestDeps({
        resolveMcpLoopbackPolicyTools: loopbackTools.resolveMcpLoopbackPolicyTools,
        resolveMcpLoopbackScopedTools: loopbackTools.resolveMcpLoopbackScopedTools,
        mintMcpLoopbackClientGrant: (params: { context: McpLoopbackRequestContext }) => {
          captured = structuredClone(params.context);
          return createTestMcpLoopbackClientGrant(params);
        },
      });
      executePreparedCliRun.mockImplementation(async (context: PreparedCliRunContext) => {
        expect(captured).toBeDefined();
        if (selectable) {
          expect(captured?.toolsAllow?.includes(toolName)).toBe(available);
        }
        const scoped = await loopbackTools.resolveMcpLoopbackScopedTools({
          cfg,
          context: captured!,
          admittedRunContext: context.params.admittedRunContext,
        });
        const toolSchema = buildMcpToolSchema(scoped.tools);
        const list = await handleMcpJsonRpc({
          message: { jsonrpc: "2.0", id: "list", method: "tools/list" },
          tools: scoped.tools,
          toolSchema,
        });
        expect(list).toMatchObject({
          result: {
            tools: available
              ? expect.arrayContaining([expect.objectContaining({ name: toolName })])
              : expect.not.arrayContaining([expect.objectContaining({ name: toolName })]),
          },
        });
        expect(toolSchema.map((t) => t.name)).not.toContain("worker_ungranted");
        expect(toolSchema.map((tool) => tool.name).includes("default_tool")).toBe(
          policy === "unrestricted",
        );
        retainedTool = scoped.tools.find((tool) => tool.name === toolName);
        if (available) {
          const unadmitted = await loopbackTools.resolveMcpLoopbackScopedTools({
            cfg,
            context: captured!,
          });
          expect(unadmitted.tools.map((tool) => tool.name)).not.toContain(toolName);
        }
        // Untrusted MCP fields cannot supply a missing host-owned run grant.
        const result = await handleMcpJsonRpc({
          message: {
            jsonrpc: "2.0",
            id: "finish",
            method: "tools/call",
            params: {
              name: toolName,
              arguments: {},
              runtimePluginToolGrant: { pluginId, toolNames: [toolName] },
            },
          },
          tools: scoped.tools,
          toolSchema,
        });
        expect(result).toMatchObject({
          result: available
            ? {
                content: [
                  { type: "text", text: JSON.stringify({ agentId: "main", finished: true }) },
                ],
              }
            : {
                isError: true,
                content: [{ type: "text", text: `Tool not available: ${toolName}` }],
              },
        });
        expect(invoked).toEqual(available ? [toolName] : []);
        return { text: "done" };
      });
      const params = makeRunAgentAttemptParams({
        agentDir: path.join(root, "agents", "main", "agent"),
        workspaceDir: root,
        sessionEntry: makeSessionEntry(`session-plugin-grant-${granted}`),
        runId: `run-plugin-grant-${granted}`,
        sessionKey: "agent:main:main",
        providerOverride: "claude-cli",
        modelOverride: "sonnet",
        cfg,
        opts: { runtimePluginToolGrant },
        preparedRunAdmission: prepareSystemAgentRunAdmission(
          cfg,
          `run-plugin-grant-${granted}`,
          "main",
          "cli-plugin-grant-test",
        ),
      });
      try {
        await runAgentAttempt(params);
      } finally {
        params.preparedRunAdmission?.close();
      }
      if (available) {
        await expect(retainedTool!.execute("expired-run", {})).rejects.toThrow(/no longer active/);
        expect(invoked).toEqual([toolName]);
      }
    },
  );

  beforeEach(async () => {
    overlays = [];
    setActivePluginRegistry(createEmptyPluginRegistry());
    await bindSessionMcpRuntimeTestScheduler();
    // Keep discovery and serialization real; only the external MCP transport is in memory.
    vi.spyOn(mcpTransport, "resolveMcpTransport").mockImplementation(() => {
      const [client, transport] = InMemoryTransport.createLinkedPair();
      const server = new Server(
        { name: "session-override-proof", version: "1" },
        {
          capabilities: { tools: {} },
        },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: "read_docs", inputSchema: { type: "object" } }],
      }));
      void server.connect(transport);
      servers.push(server);
      return {
        transport: client,
        description: "session override fixture",
        transportType: "streamable-http",
        connectionTimeoutMs: 1_000,
        requestTimeoutMs: 1_000,
        supportsParallelToolCalls: true,
      };
    });
    useCliBackend();
    setCliRunnerPrepareTestDeps({
      isWorkspaceBootstrapPending: async () => false,
      resolveBootstrapContextForRun: async () => ({ bootstrapFiles: [], contextFiles: [] }),
      getActiveMcpLoopbackRuntime: () => ({
        port: 31783,
        ownerToken: "loopback-owner-token",
        nonOwnerToken: "loopback-non-owner-token",
      }),
      ensureMcpLoopbackServer: createTestMcpLoopbackServer,
      createMcpLoopbackServerConfig: createTestMcpLoopbackServerConfig,
      mintMcpLoopbackClientGrant: createTestMcpLoopbackClientGrant,
      bindMcpLoopbackClientGrantAdmission: () => true,
      revokeMcpLoopbackClientGrant: () => true,
      resolveMcpLoopbackPolicyTools: () => ({ agentId: "main", tools: [] }),
      resolveMcpLoopbackScopedTools: () => ({ agentId: "main", tools: [] }),
      resolveOpenClawReferencePaths: async () => ({ docsPath: null, sourcePath: null }),
      prepareClaudeCliSkillsPlugin: async () => ({ args: [], cleanup: async () => {} }),
      loadManifestModelCatalog: () => [],
    });
    executePreparedCliRun.mockReset();
    executePreparedCliRun.mockImplementation(async (context: PreparedCliRunContext) => {
      const args = context.preparedBackend.backend.args;
      expect(args).toContain("--strict-mcp-config");
      const overlay = JSON.parse(await fs.readFile(requireMcpConfigPath(args), "utf8")) as {
        mcpServers: Record<string, unknown>;
      };
      overlays.push(overlay.mcpServers);
      return { text: "done" };
    });
  });

  it.each([
    { globalEnabled: false, sessionEnabled: true, expectedEnabled: true },
    { globalEnabled: true, sessionEnabled: false, expectedEnabled: false },
    { globalEnabled: true, sessionEnabled: undefined, expectedEnabled: true },
    { globalEnabled: false, sessionEnabled: undefined, expectedEnabled: false },
  ])(
    "serializes global=$globalEnabled session=$sessionEnabled as enabled=$expectedEnabled",
    async ({ globalEnabled, sessionEnabled, expectedEnabled }) => {
      const sessionEntry: SessionEntry = makeSessionEntry(
        "session-mcp",
        sessionEnabled !== undefined
          ? { toolOverrides: { mcpServers: { docs: sessionEnabled } } }
          : {},
      );
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { defaults: { skipBootstrap: true } },
        skills: { load: { watch: false } },
        mcp: {
          servers: {
            docs: {
              enabled: globalEnabled,
              transport: "streamable-http",
              url: "https://mcp.example.test/docs",
            },
          },
        },
      };
      const params = makeRunAgentAttemptParams({
        agentDir: path.join(root, "agents", "main", "agent"),
        workspaceDir: root,
        sessionEntry,
        sessionKey: "agent:main:main",
        providerOverride: "claude-cli",
        modelOverride: "sonnet",
        cfg,
        skillsSnapshot: { prompt: "", skills: [] },
        preparedRunAdmission: prepareSystemAgentRunAdmission(
          cfg,
          "run-session-mcp",
          "main",
          "cli-session-mcp-test",
        ),
      });
      try {
        const result = await runAgentAttempt(params);
        expect(result.payloads).toEqual([expect.objectContaining({ text: "done" })]);
        expect(overlays).toHaveLength(1);
        expect(Object.hasOwn(overlays[0]!, "docs")).toBe(expectedEnabled);
        if (expectedEnabled) {
          expect(overlays[0]!.docs).toMatchObject({
            type: "http",
            url: "https://mcp.example.test/docs",
          });
        }
      } finally {
        params.preparedRunAdmission?.close();
      }
    },
  );
});
