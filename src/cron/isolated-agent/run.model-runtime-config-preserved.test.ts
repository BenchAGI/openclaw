// Cron runtime tests cover agent-entry model maps merging over global per-model runtime rows.
import { describe, expect, it } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import { resolveModelRuntimePolicy } from "../../agents/model-runtime-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveCronAgentConfig } from "./run-config.js";

const anthropicCliModels = {
  "anthropic/claude-fable-5-1": { agentRuntime: { id: "claude-cli" } },
  "anthropic/claude-opus-4-8": { agentRuntime: { id: "claude-cli" } },
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
            "openai/gpt-5.6-sol": { agentRuntime: { id: "codex" } },
          },
        },
        list: [
          {
            id: "aurelius",
            models: { "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } } },
          },
        ],
      },
    };

    const cronCfg = buildCronConfig(cfg, "aurelius");

    expect(cronCfg.agents?.defaults?.models).toEqual({
      ...anthropicCliModels,
      "openai/gpt-5.6-sol": { agentRuntime: { id: "openclaw" } },
    });
    expect(
      resolveCronRuntime({
        cfg: cronCfg,
        agentId: "aurelius",
        provider: "anthropic",
        modelId: "claude-fable-5-1",
      }),
    ).toBe("claude-cli");
    expect(
      resolveCronRuntime({
        cfg: cronCfg,
        agentId: "aurelius",
        provider: "openai",
        modelId: "gpt-5.6-sol",
      }),
    ).toBe("openclaw");
  });

  it("leaves the global model map untouched when the agent entry has no models", () => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: { models: { ...anthropicCliModels } },
        list: [{ id: "worker", model: "anthropic/claude-fable-5-1" }],
      },
    };

    const cronCfg = buildCronConfig(cfg, "worker");

    expect(cronCfg.agents?.defaults?.models).toEqual(anthropicCliModels);
    expect(cronCfg.agents?.defaults?.model).toEqual({ primary: "anthropic/claude-fable-5-1" });
    expect(
      resolveCronRuntime({
        cfg: cronCfg,
        agentId: "worker",
        provider: "anthropic",
        modelId: "claude-fable-5-1",
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
});
