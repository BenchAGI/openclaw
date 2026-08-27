// Verifies model reference validation in config surfaces.
import { describe, expect, it } from "vitest";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateConfigObjectWithPlugins } from "./validation.js";

function createModelSuppressionRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        channels: [],
        providers: ["openai", "openai"],
        contracts: {},
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: "/tmp/plugins/openai",
        source: "test",
        manifestPath: "/tmp/plugins/openai/openclaw.plugin.json",
        modelCatalog: {
          suppressions: [
            {
              provider: "openai",
              model: "gpt-5.3-codex-spark",
              reason:
                "gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
            },
          ],
        },
      },
    ],
  };
}

describe("config model reference validation", () => {
  it("rejects statically suppressed provider/model pairs during config validation", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.3-codex-spark",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(false);
    if (res.ok) {
      return;
    }
    expect(res.issues).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          "Unknown model: openai/gpt-5.3-codex-spark. gpt-5.3-codex-spark is no longer exposed by the OpenAI or Codex catalogs. Use openai/gpt-5.5.",
      },
    ]);
  });

  it("accepts supported openai provider/model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });

  it("accepts available openai fallback model pairs", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.4-mini",
              fallbacks: ["openai/gpt-5.2-codex", "openai/gpt-5.3-codex"],
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelSuppressionRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
  });
});

function createModelCatalogRegistry(): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        channels: [],
        providers: ["openai"],
        contracts: {},
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: "/tmp/plugins/openai",
        source: "test",
        manifestPath: "/tmp/plugins/openai/openclaw.plugin.json",
        modelCatalog: {
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              api: "openai-responses",
              models: [{ id: "gpt-5.4", name: "GPT-5.4" }],
            },
          },
        },
      },
    ],
  };
}

function warningsForModelRef(
  res: ReturnType<typeof validateConfigObjectWithPlugins>,
  modelRef: string,
) {
  return res.warnings.filter((warning) => warning.message.includes(modelRef));
}

describe("configured model refs that resolve against no catalog", () => {
  it("warns once when a configured ref is registered nowhere", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.6-luna",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelCatalogRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(warningsForModelRef(res, "openai/gpt-5.6-luna")).toEqual([
      {
        path: "agents.defaults.model.primary",
        message:
          'Unknown model: openai/gpt-5.6-luna. No models.providers["openai"].models[] entry registers this model. Add { "id": "gpt-5.6-luna", "name": "gpt-5.6-luna" } to models.providers["openai"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.',
      },
    ]);
  });

  it("does not warn for refs pinned to an agentRuntime", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.6-luna",
            },
            models: {
              "openai/gpt-5.6-luna": {
                agentRuntime: { id: "codex" },
              },
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelCatalogRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(warningsForModelRef(res, "openai/gpt-5.6-luna")).toEqual([]);
  });

  it("does not warn for providers that ship no static model catalog", () => {
    const registry = createModelCatalogRegistry();
    registry.plugins.push({
      id: "openrouter",
      origin: "bundled",
      channels: [],
      providers: ["openrouter"],
      contracts: {},
      cliBackends: [],
      skills: [],
      hooks: [],
      rootDir: "/tmp/plugins/openrouter",
      source: "test",
      manifestPath: "/tmp/plugins/openrouter/openclaw.plugin.json",
    });
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "openrouter/anthropic/claude-sonnet-4.6",
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: registry,
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(warningsForModelRef(res, "openrouter/anthropic/claude-sonnet-4.6")).toEqual([]);
  });

  it("does not warn for refs under a provider with a configured baseUrl", () => {
    const res = validateConfigObjectWithPlugins(
      {
        agents: {
          defaults: {
            model: {
              primary: "customproxy/house-model",
            },
          },
        },
        models: {
          providers: {
            customproxy: {
              baseUrl: "http://127.0.0.1:8080/v1",
              api: "openai-completions",
              models: [{ id: "registered-model", name: "Registered model" }],
            },
          },
        },
      },
      {
        pluginMetadataSnapshot: {
          manifestRegistry: createModelCatalogRegistry(),
        },
      },
    );

    expect(res.ok).toBe(true);
    expect(warningsForModelRef(res, "customproxy/house-model")).toEqual([]);
  });
});
