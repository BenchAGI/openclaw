/**
 * Claude CLI backend descriptor. It configures Claude Code process arguments,
 * MCP bundling, session handling, environment scrubbing, and watchdog defaults.
 */
import type { CliBackendPlugin } from "openclaw/plugin-sdk/cli-backend";
import {
  CLI_FRESH_WATCHDOG_DEFAULTS,
  CLI_RESUME_WATCHDOG_DEFAULTS,
} from "openclaw/plugin-sdk/cli-backend";
import {
  CLAUDE_CLI_BACKEND_ID,
  CLAUDE_CLI_DEFAULT_MODEL_REF,
  CLAUDE_CLI_CLEAR_ENV,
  CLAUDE_CLI_MODEL_ALIASES,
  CLAUDE_CLI_SESSION_ID_FIELDS,
  normalizeClaudeBackendConfig,
  resolveClaudeCliExecutionArgs,
} from "./cli-shared.js";

/** Build the Claude CLI backend plugin descriptor. */
export function buildAnthropicCliBackend(): CliBackendPlugin {
  return {
    id: CLAUDE_CLI_BACKEND_ID,
    modelProvider: "anthropic",
    liveTest: {
      defaultModelRef: CLAUDE_CLI_DEFAULT_MODEL_REF,
      defaultImageProbe: true,
      defaultMcpProbe: true,
      docker: {
        npmPackage: "@anthropic-ai/claude-code",
        binaryName: "claude",
      },
    },
    bundleMcp: true,
    bundleMcpMode: "claude-config-file",
    nativeToolMode: "always-on",
    sideQuestionToolMode: "disabled",
    ownsNativeCompaction: true,
    config: {
      command: "claude",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--allowedTools",
        "mcp__openclaw__*",
        "--disallowedTools",
        "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
      ],
      resumeArgs: [
        "-p",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--setting-sources",
        "user",
        "--allowedTools",
        "mcp__openclaw__*",
        "--disallowedTools",
        "ScheduleWakeup,CronCreate,Bash(run_in_background:true),Monitor",
        "--resume",
        "{sessionId}",
      ],
      output: "jsonl",
      liveSession: "claude-stdio",
      input: "stdin",
      modelArg: "--model",
      modelAliases: CLAUDE_CLI_MODEL_ALIASES,
      imageArg: "@",
      imagePathScope: "workspace",
      sessionArg: "--session-id",
      sessionMode: "always",
      reseedFromRawTranscriptWhenUncompacted: true,
      sessionIdFields: [...CLAUDE_CLI_SESSION_ID_FIELDS],
      systemPromptFileArg: "--append-system-prompt-file",
      systemPromptMode: "append",
      systemPromptWhen: "always",
      clearEnv: [...CLAUDE_CLI_CLEAR_ENV],
      reliability: {
        watchdog: {
          fresh: { ...CLI_FRESH_WATCHDOG_DEFAULTS },
          resume: { ...CLI_RESUME_WATCHDOG_DEFAULTS },
        },
      },
      serialize: true,
    },
    normalizeConfig: normalizeClaudeBackendConfig,
    resolveExecutionArgs: resolveClaudeCliExecutionArgs,
  };
}

/**
 * Ultracode variant backend id. A SEPARATE registered claude-cli backend whose
 * config carries `ultracode: true` — so it runs the same plugin normalizeConfig
 * (which injects `--settings '{"ultracode":true}'`) but is selected ONLY when a
 * turn routes to its distinct, allowlisted model id (per-request, via the
 * x-openclaw-model header). The base `claude-cli` backend stays ultracode-off.
 */
export const CLAUDE_CLI_ULTRACODE_BACKEND_ID = "claude-cli-ultracode";

/**
 * Build the ultracode-enabled Claude CLI backend variant. Identical to the base
 * claude-cli backend, but with `ultracode: true` (so normalizeClaudeBackendConfig
 * injects `--settings '{"ultracode":true}'`) and model aliases mapping the
 * suffixed variant model ids back to the real Claude models (so `--model` still
 * resolves). Only turns routed to one of these model ids run ultracode.
 */
export function buildAnthropicCliBackendUltracode(): CliBackendPlugin {
  const base = buildAnthropicCliBackend();
  return {
    ...base,
    id: CLAUDE_CLI_ULTRACODE_BACKEND_ID,
    config: {
      ...base.config,
      ultracode: true,
      modelAliases: {
        ...base.config.modelAliases,
        "claude-opus-4-8-ultracode": "claude-opus-4-8",
        "claude-opus-4-7-ultracode": "claude-opus-4-7",
        "claude-opus-4-6-ultracode": "claude-opus-4-6",
        "claude-fable-5-ultracode": "claude-fable-5",
        "claude-sonnet-4-6-ultracode": "claude-sonnet-4-6",
      },
    },
  };
}
