// Cron runtime tests cover agent-entry model maps merging over global per-model runtime rows.
import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveCodeModeConfig } from "../../agents/code-mode-runtime.js";
import { resolveModelExtraParamSources } from "../../agents/model-extra-params.js";
import { resolveModelRuntimePolicy } from "../../agents/model-runtime-policy.js";
import { buildModelAliasIndex } from "../../agents/model-selection-shared.js";
import type { AgentModelEntryConfig } from "../../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronAgentConfig } from "./run-config.js";

const anthropicCliModels = {
  "anthropic/fixture-primary": { agentRuntime: { id: "claude-cli" } },
  "anthropic/fixture-secondary": { agentRuntime: { id: "claude-cli" } },
};

function buildCronConfig(cfg: OpenClawConfig, agentId: string): OpenClawConfig {
  return resolveCronAgentConfig({
    config: cfg,
    agentConfigOverride: resolveAgentConfig(cfg, agentId),
  }).cfgWithAgentDefaults;
}

function resolveCronRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  modelId: string;
}) {
  return resolveModelRuntimePolicy({
    config: params.cfg,
    provider: params.provider,
    modelId: params.modelId,
    agentId: params.agentId,
  }).policy?.id;
}

describe("resolveCronAgentConfig model runtime preservation", () => {
  it("keeps global per-model runtime rows when the agent entry maps only its own models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            ...anthropicCliModels,
            "openai/fixture-model": { agentRuntime: { id: "fixture-runtime" } },
          },
        },
        list: [
          {
            id: "worker",
            models: { "openai/fixture-model": { agentRuntime: { id: "openclaw" } } },
          },
        ],
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.models).toEqual({
      ...anthropicCliModels,
      "openai/fixture-model": { agentRuntime: { id: "openclaw" } },
    });
    expect(
      resolveCronRuntime({
        cfg: cronCfg,
        agentId: "worker",
        provider: "anthropic",
        modelId: "fixture-primary",
      }),
    ).toBe("claude-cli");
    expect(
      resolveCronRuntime({
        cfg: cronCfg,
        agentId: "worker",
        provider: "openai",
        modelId: "fixture-model",
      }),
    ).toBe("openclaw");
  });

  it("leaves the global model map untouched when the agent entry has no models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { models: { ...anthropicCliModels } },
        list: [{ id: "worker", model: "anthropic/fixture-primary" }],
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.models).toEqual(anthropicCliModels);
    expect(cronCfg.agents?.defaults?.model).toEqual({ primary: "anthropic/fixture-primary" });
    expect(
      resolveCronRuntime({
        cfg: cronCfg,
        agentId: "worker",
        provider: "anthropic",
        modelId: "fixture-primary",
      }),
    ).toBe("claude-cli");
  });

  it("does not introduce an empty model map when neither scope defines one", () => {
    const { agentDefaults } = resolveCronAgentConfig({
      config: { agents: { list: [{ id: "worker" }] } },
      agentConfigOverride: resolveAgentConfig({ agents: { list: [{ id: "worker" }] } }, "worker"),
    });

    expect(agentDefaults).not.toHaveProperty("models");
  });

  it("projects partial model fields without merging authored parameter objects", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "anthropic/fixture-primary": {
              alias: "fixture-alias",
              agentRuntime: { id: "claude-cli" },
              params: { maxTokens: 100, temperature: 1 },
              streaming: true,
              codeMode: true,
            },
          },
        },
        list: [
          {
            id: "worker",
            models: {
              "anthropic/fixture-primary": {
                params: { temperature: 0.2 },
                streaming: false,
                codeMode: false,
              },
              "anthropic/fixture-agent-only": { agentRuntime: { id: "openclaw" } },
            },
          },
        ],
      },
    };
    const original = structuredClone(cfg);
    const cronCfg = buildCronConfig(cfg, "worker");

    expect(
      resolveModelExtraParamSources({
        config: cronCfg,
        provider: "anthropic",
        modelId: "fixture-primary",
        agentId: "worker",
      }).modelParams,
    ).toEqual({ temperature: 0.2 });
    expect(
      buildModelAliasIndex({
        cfg: cronCfg,
        defaultProvider: "anthropic",
        manifestPlugins: [],
      }).byAlias.get("fixture-alias")?.ref,
    ).toEqual({
      provider: "anthropic",
      model: "fixture-primary",
    });
    expect(cronCfg.agents?.defaults?.models?.["anthropic/fixture-primary"]).toMatchObject({
      streaming: false,
      codeMode: false,
      agentRuntime: { id: "claude-cli" },
    });
    expect(
      resolveCronRuntime({
        cfg: cronCfg,
        agentId: "worker",
        provider: "anthropic",
        modelId: "fixture-agent-only",
      }),
    ).toBe("openclaw");
    expect(cfg).toEqual(original);
  });

  it.each([
    ["alias", { alias: "fixture-alias" }],
    ["parameters", { params: { temperature: 0.2 } }],
    ["streaming", { streaming: false }],
    ["code mode", { codeMode: false }],
    ["empty entry", {}],
    ["undefined runtime", { agentRuntime: undefined }],
    ["empty runtime", { agentRuntime: {} }],
    ["undefined runtime ID", { agentRuntime: { id: undefined } }],
    ["empty runtime ID", { agentRuntime: { id: "" } }],
    ["blank runtime ID", { agentRuntime: { id: "  " } }],
  ] satisfies Array<[string, AgentModelEntryConfig]>)(
    "preserves inherited runtime with same-model %s overrides",
    (_name, entry) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { models: { ...anthropicCliModels } },
          list: [{ id: "worker", models: { "anthropic/fixture-primary": entry } }],
        },
      };
      const original = structuredClone(cfg);
      const cronCfg = buildCronConfig(cfg, "worker");
      const selection = {
        agentId: "worker",
        provider: "anthropic",
        modelId: "fixture-primary",
      };

      expect(resolveCronRuntime({ cfg, ...selection })).toBe("claude-cli");
      expect(resolveCronRuntime({ cfg: cronCfg, ...selection })).toBe("claude-cli");
      expect(cfg).toEqual(original);
    },
  );

  it.each([undefined, false])(
    "preserves nullish model Code Mode with agent-tools override %s",
    (agentCodeMode) => {
      const cfg: OpenClawConfig = {
        tools: { codeMode: false },
        agents: {
          defaults: { models: { "anthropic/fixture-primary": { codeMode: true } } },
          list: [
            {
              id: "worker",
              tools: { codeMode: agentCodeMode },
              models: { "anthropic/fixture-primary": { codeMode: undefined } },
            },
          ],
        },
      };
      const selection = { provider: "anthropic", modelId: "fixture-primary" };
      const expected = agentCodeMode ?? true;

      expect(resolveCodeModeConfig(cfg, "worker", selection).enabled).toBe(expected);
      expect(
        resolveCodeModeConfig(buildCronConfig(cfg, "worker"), "worker", selection).enabled,
      ).toBe(expected);
    },
  );

  it.each(["auto", "default", "openclaw"])("retains explicit runtime %s", (id) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { models: { ...anthropicCliModels } },
        list: [{ id: "worker", models: { "anthropic/fixture-primary": { agentRuntime: { id } } } }],
      },
    };
    expect(
      resolveCronRuntime({
        cfg: buildCronConfig(cfg, "worker"),
        agentId: "worker",
        provider: "anthropic",
        modelId: "fixture-primary",
      }),
    ).toBe(id);
  });

  it("preserves a same-row provider wildcard runtime", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { models: { "anthropic/*": { agentRuntime: { id: "claude-cli" } } } },
        list: [{ id: "worker", models: { "anthropic/*": { params: { temperature: 0.2 } } } }],
      },
    };
    expect(
      resolveCronRuntime({
        cfg: buildCronConfig(cfg, "worker"),
        agentId: "worker",
        provider: "anthropic",
        modelId: "fixture-primary",
      }),
    ).toBe("claude-cli");
  });
});
