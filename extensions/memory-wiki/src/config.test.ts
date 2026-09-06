// Memory Wiki tests cover config plugin behavior.
import fs from "node:fs";
import path from "node:path";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { memoryWikiConfigSchema } from "./config-schema.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  return (value: unknown) =>
    validateJsonSchemaValue({
      cacheKey: "memory-wiki.manifest.config.test",
      schema: manifest.configSchema,
      value,
      applyDefaults: true,
    }).ok;
}

describe("resolveMemoryWikiConfig", () => {
  it("returns isolated defaults", () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });

    expect(config.vaultMode).toBe("isolated");
    expect(config.vault.scope).toBe("global");
    expect(config.vault.renderMode).toBe("native");
    expect(config.vault.path).toBe(path.join("/Users/tester", ".openclaw", "wiki", "main"));
    expect(config.search.backend).toBe("shared");
    expect(config.search.corpus).toBe("wiki");
    expect(config.context.includeCompiledDigestPrompt).toBe(false);
  });

  it.each([
    { scope: "global" as const, segments: ["wiki", "main"] },
    { scope: "agent" as const, segments: ["wiki"] },
  ])("keeps default $scope vaults inside the configured state directory", ({ scope, segments }) => {
    const stateDir = "/tmp/openclaw-isolated-state";
    const config = resolveMemoryWikiConfig(
      { vault: { scope } },
      {
        homedir: "/Users/tester",
        env: { HOME: "/Users/tester", OPENCLAW_STATE_DIR: stateDir },
      },
    );

    expect(config.vault.path).toBe(path.join(stateDir, ...segments));
  });

  it("uses the configured state directory for schema-resolved defaults", () => {
    const stateDir = "/tmp/openclaw-schema-state";

    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const parsed = memoryWikiConfigSchema.safeParse?.(undefined);

      expect(parsed).toMatchObject({
        success: true,
        data: { vault: { path: path.join(stateDir, "wiki", "main") } },
      });
    });
  });

  it("expands ~/ paths and preserves explicit modes", () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        vault: {
          path: "~/vaults/wiki",
          renderMode: "obsidian",
        },
      },
      {
        homedir: "/Users/tester",
        env: { HOME: "/Users/tester", OPENCLAW_STATE_DIR: "/tmp/openclaw-isolated-state" },
      },
    );

    expect(config.vaultMode).toBe("bridge");
    expect(config.vault.path).toBe(path.join("/Users/tester", "vaults", "wiki"));
    expect(config.vault.renderMode).toBe("obsidian");
  });

  it("normalizes the bridge artifact toggle", () => {
    const canonical = resolveMemoryWikiConfig({
      bridge: {
        readMemoryArtifacts: false,
      },
    });

    expect(canonical.bridge.readMemoryArtifacts).toBe(false);
  });

  it("resolves normalized agent ids to distinct vault roots", () => {
    const base = resolveMemoryWikiConfig(
      {
        vault: {
          scope: "agent",
          path: "~/vaults/wiki",
        },
      },
      { homedir: "/Users/tester" },
    );
    const appConfig = {
      agents: {
        list: [{ id: "Support Team", default: true }, { id: "Marketing" }],
      },
    } as OpenClawConfig;

    const support = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig,
      agentId: " SUPPORT TEAM ",
    });
    const marketing = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig,
      agentId: "MARKETING",
    });

    expect(base.vault.path).toBe(path.join("/Users/tester", "vaults", "wiki"));
    expect(support).toMatchObject({
      agentId: "support-team",
      vault: { scope: "agent", path: path.join(base.vault.path, "support-team") },
    });
    expect(marketing).toMatchObject({
      agentId: "marketing",
      vault: { scope: "agent", path: path.join(base.vault.path, "marketing") },
    });
    expect(support.vault.path).not.toBe(marketing.vault.path);
  });

  it("uses the wiki root before appending the single configured agent", () => {
    const base = resolveMemoryWikiConfig(
      { vault: { scope: "agent" } },
      { homedir: "/Users/tester" },
    );

    const resolved = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig: { agents: { list: [{ id: "support", default: true }] } },
    });

    const expectedRoot = path.join("/Users/tester", ".openclaw", "wiki");
    expect(base.vault.path).toBe(expectedRoot);
    expect(resolved.vault.path).toBe(path.join(expectedRoot, "support"));
  });

  it("fails closed when a multi-agent scoped vault has no agent context", () => {
    const config = resolveMemoryWikiConfig({ vault: { scope: "agent" } });
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
    } as OpenClawConfig;

    expect(() => resolveMemoryWikiAgentConfig({ config, appConfig })).toThrow(
      "agentId is required",
    );
  });

  it("fails closed for unknown scoped agents", () => {
    const config = resolveMemoryWikiConfig({ vault: { scope: "agent" } });
    const appConfig = {
      agents: { list: [{ id: "support", default: true }, { id: "marketing" }] },
    } as OpenClawConfig;

    expect(() => resolveMemoryWikiAgentConfig({ config, appConfig, agentId: "finance" })).toThrow(
      "Unknown memory-wiki agentId: finance",
    );
  });

  it("rejects unsafe-local access for agent-scoped vaults", () => {
    const parsed = memoryWikiConfigSchema.safeParse?.({
      vaultMode: "unsafe-local",
      vault: { scope: "agent" },
    });

    expect(parsed?.success).toBe(false);
    if (parsed?.success === false) {
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["vaultMode"],
          message: "vaultMode=unsafe-local cannot be combined with vault.scope=agent",
        }),
      );
    }
  });

  it("rejects the global Obsidian CLI selector for agent-scoped vaults", () => {
    const parsed = memoryWikiConfigSchema.safeParse?.({
      vault: { scope: "agent" },
      obsidian: { useOfficialCli: true },
    });

    expect(parsed?.success).toBe(false);
    if (parsed?.success === false) {
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["obsidian", "useOfficialCli"],
          message: "obsidian.useOfficialCli cannot be enabled with vault.scope=agent",
        }),
      );
    }
  });

  it("scopes vault path to instanceId when set (Phase D2.1)", () => {
    const config = resolveMemoryWikiConfig(undefined, {
      homedir: "/Users/tester",
      instanceId: "acme-corp",
    });
    expect(config.vault.path).toBe("/Users/tester/.openclaw/wiki/acme-corp");
  });

  it("falls back to main vault when instanceId is absent (Tier A)", () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });
    expect(config.vault.path).toBe("/Users/tester/.openclaw/wiki/main");
  });

  it("rejects path-traversal instanceIds and falls back to main", () => {
    const config = resolveMemoryWikiConfig(undefined, {
      homedir: "/Users/tester",
      instanceId: "../evil",
    });
    expect(config.vault.path).toBe("/Users/tester/.openclaw/wiki/main");
  });

  it("respects an explicit vault.path override even when instanceId is set", () => {
    const config = resolveMemoryWikiConfig(
      { vault: { path: "~/custom/wiki" } },
      { homedir: "/Users/tester", instanceId: "acme-corp" },
    );
    expect(config.vault.path).toBe("/Users/tester/custom/wiki");
  });
});

describe("resolveDefaultMemoryWikiVaultPath", () => {
  it("returns the main vault when no instanceId is given", () => {
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester")).toBe(
      "/Users/tester/.openclaw/wiki/main",
    );
  });

  it("scopes to the instanceId when valid", () => {
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester", "bench-prod-01")).toBe(
      "/Users/tester/.openclaw/wiki/bench-prod-01",
    );
  });

  it("falls back to main on invalid instanceId", () => {
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester", "has/slash")).toBe(
      "/Users/tester/.openclaw/wiki/main",
    );
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester", "")).toBe(
      "/Users/tester/.openclaw/wiki/main",
    );
  });
});

describe("memory-wiki manifest config schema", () => {
  it("accepts the documented config shape", () => {
    const validate = compileManifestConfigSchema();
    const config = {
      vaultMode: "unsafe-local",
      vault: {
        path: "~/wiki",
        renderMode: "obsidian",
      },
      obsidian: {
        enabled: true,
        useOfficialCli: true,
      },
      bridge: {
        enabled: true,
        readMemoryArtifacts: true,
        followMemoryEvents: true,
      },
      unsafeLocal: {
        allowPrivateMemoryCoreAccess: true,
        paths: ["extensions/memory-core/src"],
      },
      search: {
        backend: "shared",
        corpus: "all",
      },
      context: {
        includeCompiledDigestPrompt: true,
      },
    };

    expect(validate(config)).toBe(true);
  });

  it("rejects unsafe-local access for agent-scoped vaults", () => {
    const validate = compileManifestConfigSchema();

    expect(
      validate({
        vaultMode: "unsafe-local",
        vault: { scope: "agent" },
      }),
    ).toBe(false);
  });

  it("rejects the global Obsidian CLI selector for agent-scoped vaults", () => {
    const validate = compileManifestConfigSchema();

    expect(
      validate({
        vault: { scope: "agent" },
        obsidian: { useOfficialCli: true },
      }),
    ).toBe(false);
  });
});
