/**
 * /v1/llm_turn — Phase 1B W3 (Cloud-Brain via Relay).
 *
 * Receives an inline-persona Anthropic-call payload from the relay (which
 * claimed an `llm_turn` directive emitted by the cloud orchestrator), runs the
 * Anthropic call with the install's locally-configured auth profile, and
 * returns the response. Spec §7 lines 709-740.
 *
 * Persona-off-disk invariant: `system_prompt` arrives inline in the request
 * body — this endpoint MUST NOT write the persona to disk. The legacy
 * `/v1/chat` path reads `${workspace}/SOUL.md`; this endpoint deliberately
 * does not.
 *
 * Casing convention (spec §7 line 741): HTTP wire format is snake_case;
 * TypeScript types in this module are camelCase; the deserialization layer
 * (this handler) maps between them on inbound parse + outbound serialize.
 *
 * Auth profile resolution: NOT specified by the cloud. The handler resolves
 * the agent's local Anthropic profile from OpenClaw config and surfaces the
 * resolved profile name back to the cloud as `used_auth_profile` in the
 * response. The cloud uses that to decide between OAuth-mode (don't write
 * `aiUsageRecords`) and API/coin-mode (write `aiUsageRecords` with
 * `kind: 'cloud-brain-api-mode'`) per spec §6.
 *
 * SCAFFOLD STATUS (this PR):
 * - Route registration + body validation + auth check: IMPLEMENTED
 * - Idempotency-key write-ahead store: TODO (lease-recovery semantics — spec
 *   §7 line 851)
 * - Anthropic call (resolve profile, build params, call SDK, translate
 *   response): TODO — see CALL_ANTHROPIC_TODO comment below
 * - JWT auth (replacing shared-secret): TODO — spec §7 line 811
 * - Cache control hints: TODO — spec §7 line 707
 * - Streaming: TODO — spec §7 line 826
 *
 * The validation + route-registration scaffold is enough for W2 to begin
 * dispatching directives in test mode (returning a controlled error response).
 */

import fs from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runCliAgent } from "../agents/cli-runner.js";
import { parseModelRef } from "../agents/model-selection.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import { loadConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { sendJson } from "./http-common.js";
import { handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers.js";
import { resolveOpenAiCompatibleHttpOperatorScopes } from "./http-utils.js";

// ─── Public types (TypeScript camelCase) ─────────────────────────────────

export type LlmTurnHttpOptions = {
  auth: ResolvedGatewayAuth;
  maxBodyBytes?: number;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

/**
 * Wire-format request body — fields are snake_case per spec §7 line 741.
 * Internally we deserialize to a camelCase shape before processing.
 */
interface LlmTurnWireRequest {
  agent_id?: unknown;
  messages?: unknown;
  system_prompt?: unknown;
  tools?: unknown;
  model?: unknown;
  thinking_level?: unknown;
  max_tokens?: unknown;
  cache_control?: unknown;
  idempotency_key?: unknown;
}

export interface LlmTurnRequest {
  agentId: string;
  messages: Array<{ role: string; content: unknown }>;
  systemPrompt: string;
  tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }>;
  model: string;
  thinkingLevel?: string;
  maxTokens: number;
  cacheControl?: { system?: string };
  idempotencyKey: string;
}

// ─── Constants ───────────────────────────────────────────────────────────

const DEFAULT_LLM_TURN_BODY_BYTES = 5 * 1024 * 1024;
const MAX_MESSAGES_LENGTH = 256;
const MAX_TOOLS_LENGTH = 128;
const MAX_SYSTEM_PROMPT_LENGTH = 256_000;

// ─── Validation ──────────────────────────────────────────────────────────

export type LlmTurnValidationError =
  | { code: "invalid_field"; field: string; reason: string }
  | { code: "missing_field"; field: string }
  | { code: "oversized_field"; field: string; limit: number; actual: number };

export type LlmTurnValidationResult =
  | { ok: true; request: LlmTurnRequest }
  | { ok: false; error: LlmTurnValidationError };

/**
 * Validate + parse the wire-format request body into a TypeScript-shape
 * `LlmTurnRequest`. Pure function — no I/O.
 *
 * Exported separately from the HTTP handler so the validator can be unit-
 * tested without standing up the gateway.
 */
export function validateLlmTurnRequest(body: unknown): LlmTurnValidationResult {
  // Top-level guard: JSON bodies of `null`, primitives, or arrays would
  // otherwise throw on field access and produce a generic 500 from the
  // dispatch error handler (Codex W3 finding #1). Reject early with a
  // 400-shaped invalid_field result.
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      error: {
        code: "invalid_field",
        field: "<root>",
        reason: "request body must be a JSON object",
      },
    };
  }
  const wire = body as LlmTurnWireRequest;
  const agentId = normalizeOptionalString(wire.agent_id);
  if (!agentId) {
    return { ok: false, error: { code: "missing_field", field: "agent_id" } };
  }

  const systemPrompt = typeof wire.system_prompt === "string" ? wire.system_prompt : null;
  if (systemPrompt === null) {
    return { ok: false, error: { code: "missing_field", field: "system_prompt" } };
  }
  if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
    return {
      ok: false,
      error: {
        code: "oversized_field",
        field: "system_prompt",
        limit: MAX_SYSTEM_PROMPT_LENGTH,
        actual: systemPrompt.length,
      },
    };
  }

  if (!Array.isArray(wire.messages)) {
    return { ok: false, error: { code: "missing_field", field: "messages" } };
  }
  if (wire.messages.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_field",
        field: "messages",
        reason: "must contain at least one message",
      },
    };
  }
  if (wire.messages.length > MAX_MESSAGES_LENGTH) {
    return {
      ok: false,
      error: {
        code: "oversized_field",
        field: "messages",
        limit: MAX_MESSAGES_LENGTH,
        actual: wire.messages.length,
      },
    };
  }
  const messages: LlmTurnRequest["messages"] = [];
  for (let i = 0; i < wire.messages.length; i++) {
    const m = wire.messages[i] as { role?: unknown; content?: unknown };
    if (!m || typeof m !== "object") {
      return {
        ok: false,
        error: { code: "invalid_field", field: `messages[${i}]`, reason: "must be an object" },
      };
    }
    const role = normalizeOptionalString(m.role);
    if (!role || (role !== "user" && role !== "assistant")) {
      return {
        ok: false,
        error: {
          code: "invalid_field",
          field: `messages[${i}].role`,
          reason: "must be 'user' or 'assistant'",
        },
      };
    }
    if (m.content === undefined || m.content === null) {
      return {
        ok: false,
        error: { code: "missing_field", field: `messages[${i}].content` },
      };
    }
    messages.push({ role, content: m.content });
  }

  const tools: LlmTurnRequest["tools"] = [];
  if (wire.tools !== undefined) {
    if (!Array.isArray(wire.tools)) {
      return {
        ok: false,
        error: { code: "invalid_field", field: "tools", reason: "must be an array" },
      };
    }
    if (wire.tools.length > MAX_TOOLS_LENGTH) {
      return {
        ok: false,
        error: {
          code: "oversized_field",
          field: "tools",
          limit: MAX_TOOLS_LENGTH,
          actual: wire.tools.length,
        },
      };
    }
    for (let i = 0; i < wire.tools.length; i++) {
      const t = wire.tools[i] as {
        name?: unknown;
        description?: unknown;
        input_schema?: unknown;
      };
      if (!t || typeof t !== "object") {
        return {
          ok: false,
          error: { code: "invalid_field", field: `tools[${i}]`, reason: "must be an object" },
        };
      }
      const name = normalizeOptionalString(t.name);
      if (!name) {
        return { ok: false, error: { code: "missing_field", field: `tools[${i}].name` } };
      }
      const description = typeof t.description === "string" ? t.description : "";
      const inputSchema =
        t.input_schema && typeof t.input_schema === "object"
          ? (t.input_schema as Record<string, unknown>)
          : null;
      if (!inputSchema) {
        return {
          ok: false,
          error: { code: "missing_field", field: `tools[${i}].input_schema` },
        };
      }
      tools.push({ name, description, input_schema: inputSchema });
    }
  }

  const model = normalizeOptionalString(wire.model);
  if (!model) {
    return { ok: false, error: { code: "missing_field", field: "model" } };
  }

  const thinkingLevel = normalizeOptionalString(wire.thinking_level) ?? undefined;

  const maxTokensRaw = wire.max_tokens;
  // Require a positive integer (Codex W3 finding #2): the original
  // `Number.isFinite(...) && > 0` allowed `0.5` to floor to 0 token budget.
  if (typeof maxTokensRaw !== "number" || !Number.isInteger(maxTokensRaw) || maxTokensRaw <= 0) {
    return {
      ok: false,
      error: {
        code: "invalid_field",
        field: "max_tokens",
        reason: "must be a positive integer",
      },
    };
  }
  const maxTokens = maxTokensRaw;

  const cacheControl =
    wire.cache_control && typeof wire.cache_control === "object"
      ? (wire.cache_control as { system?: unknown })
      : undefined;
  const cacheControlNormalized = cacheControl
    ? { system: normalizeOptionalString(cacheControl.system) ?? undefined }
    : undefined;

  const idempotencyKey = normalizeOptionalString(wire.idempotency_key);
  if (!idempotencyKey) {
    return { ok: false, error: { code: "missing_field", field: "idempotency_key" } };
  }

  return {
    ok: true,
    request: {
      agentId,
      messages,
      systemPrompt,
      tools,
      model,
      thinkingLevel,
      maxTokens,
      cacheControl: cacheControlNormalized,
      idempotencyKey,
    },
  };
}

// ─── HTTP handler ────────────────────────────────────────────────────────

/**
 * Handle a POST `/v1/llm_turn` request.
 *
 * SCAFFOLD: validates the request shape and returns 501 `not_implemented`
 * for the Anthropic call. Returns `Promise<boolean>` to match the existing
 * gateway dispatch contract:
 *   - `false`  → pathname didn't match (let next handler try)
 *   - `true`   → request handled (response already sent)
 */
export async function handleLlmTurnHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: LlmTurnHttpOptions,
): Promise<boolean> {
  const handled = await handleGatewayPostJsonEndpoint(req, res, {
    pathname: "/v1/llm_turn",
    requiredOperatorMethod: "chat.send",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
    auth: options.auth,
    trustedProxies: options.trustedProxies,
    allowRealIpFallback: options.allowRealIpFallback,
    rateLimiter: options.rateLimiter,
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_LLM_TURN_BODY_BYTES,
  });
  if (handled === false) {
    return false;
  }
  if (!handled) {
    return true;
  }

  const payload = handled.body as LlmTurnWireRequest;
  const validation = validateLlmTurnRequest(payload);
  if (!validation.ok) {
    sendJson(res, 400, {
      error: {
        type: "invalid_request_error",
        code: validation.error.code,
        ...("field" in validation.error ? { field: validation.error.field } : {}),
        ...("reason" in validation.error ? { reason: validation.error.reason } : {}),
        ...("limit" in validation.error
          ? { limit: validation.error.limit, actual: validation.error.actual }
          : {}),
      },
    });
    return true;
  }

  const executionResult = await runLlmTurn(validation.request);
  if (!executionResult.ok) {
    logWarn(
      `[llm_turn] call failed for agent=${validation.request.agentId}: ` +
        `${executionResult.code} ${executionResult.message}`,
    );
    sendJson(res, executionResult.httpStatus, {
      error: {
        type: executionResult.errorType,
        code: executionResult.code,
        message: executionResult.message,
      },
    });
    return true;
  }

  sendJson(res, 200, executionResult.response);
  return true;
}

// ─── LLM execution ───────────────────────────────────────────────────────

/**
 * Wire-format response (snake_case per spec §7 line 741).
 */
interface LlmTurnWireResponse {
  content: unknown;
  stop_reason: string;
  model: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  used_auth_profile: string;
}

type LlmTurnExecutionSuccess = { ok: true; response: LlmTurnWireResponse };
type LlmTurnExecutionFailure = {
  ok: false;
  httpStatus: number;
  errorType: string;
  code: string;
  message: string;
};
type LlmTurnExecutionResult = LlmTurnExecutionSuccess | LlmTurnExecutionFailure;

export type LlmTurnModelRoute =
  | { kind: "anthropic"; model: string }
  | { kind: "cli"; provider: "claude-cli" | "codex-cli"; model: string; originalProvider: string };

const CLI_LLM_TURN_TIMEOUT_MS = 240_000;

function buildLlmTurnFailure(params: {
  httpStatus: number;
  errorType: string;
  code: string;
  message: string;
}): LlmTurnExecutionFailure {
  return {
    ok: false,
    httpStatus: params.httpStatus,
    errorType: params.errorType,
    code: params.code,
    message: params.message,
  };
}

export function resolveLlmTurnModelRoute(rawModel: string): LlmTurnModelRoute {
  const parsed = parseModelRef(rawModel, "anthropic", { allowPluginNormalization: false });
  if (!parsed) {
    return { kind: "anthropic", model: rawModel };
  }

  switch (parsed.provider) {
    case "claude-cli":
      return {
        kind: "cli",
        provider: "claude-cli",
        model: parsed.model,
        originalProvider: parsed.provider,
      };
    case "codex-cli":
      return {
        kind: "cli",
        provider: "codex-cli",
        model: parsed.model,
        originalProvider: parsed.provider,
      };
    case "openai-codex":
      return {
        kind: "cli",
        provider: "codex-cli",
        model: parsed.model,
        originalProvider: parsed.provider,
      };
    default:
      return { kind: "anthropic", model: rawModel };
  }
}

function normalizeThinkLevel(value: string | undefined): ThinkLevel | undefined {
  switch (value) {
    case "off":
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "adaptive":
      return value;
    default:
      return undefined;
  }
}

function stringifyUnknownContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((entry) => {
        if (!entry || typeof entry !== "object") {
          return stringifyUnknownContent(entry);
        }
        const block = entry as Record<string, unknown>;
        if (typeof block.text === "string") {
          return block.text;
        }
        if (typeof block.content === "string") {
          return block.content;
        }
        if (Array.isArray(block.content)) {
          return stringifyUnknownContent(block.content);
        }
        if (typeof block.type === "string") {
          return `[${block.type}]`;
        }
        return "";
      })
      .map((entry) => entry.trim())
      .filter(Boolean);
    return parts.join("\n\n");
  }
  if (content && typeof content === "object") {
    try {
      return JSON.stringify(content);
    } catch {
      return "[unserializable object]";
    }
  }
  if (content === undefined || content === null) {
    return "";
  }
  if (
    typeof content === "number" ||
    typeof content === "bigint" ||
    typeof content === "boolean" ||
    typeof content === "symbol"
  ) {
    return content.toString();
  }
  return "";
}

export function buildLlmTurnCliPrompt(request: LlmTurnRequest): string {
  const transcript = request.messages
    .map((message) => {
      const role = message.role === "assistant" ? "Assistant" : "User";
      const text = stringifyUnknownContent(message.content).trim();
      return `${role}:\n${text || "[empty]"}`;
    })
    .join("\n\n");

  const toolsNote =
    request.tools.length > 0
      ? [
          "Cloud-declared tool schemas were included with this turn.",
          "Use locally available OpenClaw/MCP tools when appropriate; do not invent tool results.",
        ].join(" ")
      : "";

  return [
    "Continue the cloud-brain conversation below.",
    "The complete persona and operating policy were supplied as the system prompt for this run.",
    toolsNote,
    transcript,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function withInlineLlmTurnSystemPrompt(
  cfg: OpenClawConfig,
  agentId: string,
  systemPrompt: string,
): OpenClawConfig {
  const normalizedAgentId = normalizeAgentId(agentId);
  const configuredAgents = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
  let patchedAgent = false;
  const agentList = configuredAgents.map((entry) => {
    if (!entry || typeof entry !== "object" || normalizeAgentId(entry.id) !== normalizedAgentId) {
      return entry;
    }
    patchedAgent = true;
    return { ...entry, systemPromptOverride: systemPrompt };
  });
  if (!patchedAgent) {
    agentList.push({ id: normalizedAgentId, systemPromptOverride: systemPrompt });
  }

  return {
    ...cfg,
    agents: {
      ...cfg.agents,
      list: agentList,
      defaults: {
        ...cfg.agents?.defaults,
        systemPromptOverride: systemPrompt,
        bootstrapPromptTruncationWarning: "off",
      },
    },
  };
}

async function resolveLlmTurnWorkspaceDir(agentId: string): Promise<string> {
  const safeAgentId = normalizeAgentId(agentId);
  const dir = path.join(resolveStateDir(), "cloud-brain-runs", safeAgentId);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

function extractCliResponseText(result: Awaited<ReturnType<typeof runCliAgent>>): string {
  const visibleText = result.meta.finalAssistantVisibleText?.trim();
  if (visibleText) {
    return visibleText;
  }
  const payloadText = (result.payloads ?? [])
    .filter((payload) => !payload.isError && !payload.isReasoning)
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  return payloadText || "No response from OpenClaw CLI runner.";
}

function normalizeCliUsage(
  usage: Awaited<ReturnType<typeof runCliAgent>>["meta"]["agentMeta"] extends { usage?: infer U }
    ? U
    : unknown,
): LlmTurnWireResponse["usage"] {
  const record =
    usage && typeof usage === "object"
      ? (usage as {
          input?: number;
          output?: number;
          cacheRead?: number;
          cacheWrite?: number;
        })
      : {};
  return {
    input_tokens: Math.max(0, record.input ?? 0),
    output_tokens: Math.max(0, record.output ?? 0),
    cache_read_input_tokens: Math.max(0, record.cacheRead ?? 0),
    cache_creation_input_tokens: Math.max(0, record.cacheWrite ?? 0),
  };
}

async function callCliForLlmTurn(
  request: LlmTurnRequest,
  route: Extract<LlmTurnModelRoute, { kind: "cli" }>,
): Promise<LlmTurnExecutionResult> {
  try {
    const cfg = withInlineLlmTurnSystemPrompt(loadConfig(), request.agentId, request.systemPrompt);
    const workspaceDir = await resolveLlmTurnWorkspaceDir(request.agentId);
    const sessionAgentId = normalizeAgentId(request.agentId);
    const sessionToken =
      request.idempotencyKey.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || "turn";
    const result = await runCliAgent({
      sessionId: `cloud-brain-${sessionAgentId}-${sessionToken}`,
      sessionKey: `agent:${sessionAgentId}:cloud-brain-${sessionToken}`,
      agentId: request.agentId,
      sessionFile: path.join(workspaceDir, "llm-turn-session.json"),
      workspaceDir,
      config: cfg,
      prompt: buildLlmTurnCliPrompt(request),
      provider: route.provider,
      model: route.model,
      thinkLevel: normalizeThinkLevel(request.thinkingLevel),
      timeoutMs: Number(process.env.OPENCLAW_LLM_TURN_CLI_TIMEOUT_MS) || CLI_LLM_TURN_TIMEOUT_MS,
      runId: request.idempotencyKey,
      senderIsOwner: true,
    });

    return {
      ok: true,
      response: {
        content: [{ type: "text", text: extractCliResponseText(result) }],
        stop_reason: result.meta.completion?.stopReason ?? "end_turn",
        model: `${route.provider}/${route.model}`,
        usage: normalizeCliUsage(result.meta.agentMeta?.usage),
        used_auth_profile:
          result.meta.agentMeta?.cliSessionBinding?.authProfileId ??
          (route.originalProvider === route.provider
            ? route.provider
            : `${route.provider}:via-${route.originalProvider}`),
      },
    };
  } catch (err) {
    return buildLlmTurnFailure({
      httpStatus: 502,
      errorType: "cli_call_failed",
      code: "cli_call_failed",
      message: formatErrorMessage(err),
    });
  }
}

async function runLlmTurn(request: LlmTurnRequest): Promise<LlmTurnExecutionResult> {
  const route = resolveLlmTurnModelRoute(request.model);
  if (route.kind === "cli") {
    return callCliForLlmTurn(request, route);
  }
  return callAnthropicForLlmTurn(request, route.model);
}

/**
 * Resolve the Anthropic auth credential.
 *
 * MVP: uses `process.env.ANTHROPIC_API_KEY` (or the OAuth-token-shaped variant
 * if present). Reports profile name `'env-api-key'` or `'env-oauth-token'`.
 *
 * **Auth-profile-machinery integration is the next sub-PR.** The proper path is:
 * 1. Read agent dir from openclaw config (`resolveAgentDir(agentId)`).
 * 2. Load auth-profile store (`loadAuthProfileStoreForSecretsRuntime`).
 * 3. Pick the agent's default profile via `resolveAuthProfileOrder`.
 * 4. Use the profile's credential (handles OAuth refresh via existing
 *    `oauth.ts` machinery).
 * 5. Surface the profile name (e.g. `'anthropic-default'`,
 *    `'anthropic-bench-coin'`) in `used_auth_profile`.
 *
 * Until that lands, the env credential gives Cory's local OpenClaw a working
 * smoke test path so end-to-end can be validated.
 */
function resolveAnthropicCredential(): {
  apiKey: string | null;
  profileName: string;
  isOAuthToken: boolean;
} {
  // Anthropic SDK convention: `ANTHROPIC_AUTH_TOKEN` for OAuth tokens,
  // `ANTHROPIC_API_KEY` for API keys. Codex W3-anthropic P1 #2 — original
  // resolver only checked ANTHROPIC_API_KEY which broke OAuth-only setups.
  // Read both; OAuth takes precedence when both are set (matches SDK behavior).
  const oauthToken = (process.env.ANTHROPIC_AUTH_TOKEN ?? "").trim();
  const apiKey = (process.env.ANTHROPIC_API_KEY ?? "").trim();
  if (oauthToken) {
    return { apiKey: oauthToken, profileName: "env-oauth-token", isOAuthToken: true };
  }
  if (apiKey) {
    // Some setups put an OAuth-shaped token in ANTHROPIC_API_KEY (Anthropic
    // OAuth tokens start with `sk-ant-oat`). Detect and route accordingly.
    const looksOAuth = /^sk-ant-oat/i.test(apiKey);
    return {
      apiKey,
      profileName: looksOAuth ? "env-oauth-token" : "env-api-key",
      isOAuthToken: looksOAuth,
    };
  }
  return { apiKey: null, profileName: "no-credential", isOAuthToken: false };
}

/**
 * Translate the validated `LlmTurnRequest` (camelCase) into Anthropic SDK
 * params and call `messages.create`. Returns the SDK response translated to
 * the snake_case wire response shape.
 */
async function callAnthropicForLlmTurn(
  request: LlmTurnRequest,
  model: string,
): Promise<LlmTurnExecutionResult> {
  const { apiKey, profileName, isOAuthToken } = resolveAnthropicCredential();
  if (!apiKey) {
    return buildLlmTurnFailure({
      httpStatus: 500,
      errorType: "auth_failed",
      code: "no_anthropic_credential",
      message:
        "OpenClaw has no Anthropic credential available (ANTHROPIC_API_KEY not set). " +
        "Configure the agent's auth profile or set the env var to use /v1/llm_turn.",
    });
  }

  const client = isOAuthToken
    ? new Anthropic({ apiKey: null as unknown as string, authToken: apiKey })
    : new Anthropic({ apiKey });

  // Build the SDK call. Cache-control on the system prompt is opt-in per
  // request (spec §7 line 707).
  const systemParam =
    request.cacheControl?.system === "ephemeral"
      ? [
          {
            type: "text" as const,
            text: request.systemPrompt,
            cache_control: { type: "ephemeral" as const },
          },
        ]
      : request.systemPrompt;

  // Map TS thinking levels to Anthropic SDK thinking config. Codex W3-anthropic
  // P1 #1: Anthropic requires `thinking.budget_tokens < max_tokens`. Cap the
  // budget to `request.maxTokens - 1` reserving at least 1 output token; if
  // the requested level's budget is below the cap, use it as-is. `off` omits
  // the thinking config entirely.
  const desiredBudget = (() => {
    switch (request.thinkingLevel) {
      case "low":
        return 4096;
      case "medium":
        return 8192;
      case "high":
        return 16_384;
      case "xhigh":
        return 32_768;
      default:
        return null;
    }
  })();
  const thinking = (() => {
    if (desiredBudget === null) {
      return undefined;
    }
    // Reserve at least 1024 output tokens beyond the thinking budget so the
    // model has room to actually answer; cap budget to maxTokens - 1024 floor.
    const maxBudget = Math.max(1, request.maxTokens - 1024);
    const budget = Math.min(desiredBudget, maxBudget);
    if (budget < 1024) {
      // Below the Anthropic minimum thinking budget — disable rather than
      // send an invalid request.
      return undefined;
    }
    return { type: "enabled" as const, budget_tokens: budget };
  })();

  try {
    const sdkResponse = await client.messages.create({
      model,
      max_tokens: request.maxTokens,
      system: systemParam as never,
      messages: request.messages as never,
      ...(request.tools.length > 0 ? { tools: request.tools as never } : {}),
      ...(thinking ? { thinking } : {}),
    });

    return {
      ok: true,
      response: {
        content: sdkResponse.content,
        stop_reason: sdkResponse.stop_reason ?? "end_turn",
        model: sdkResponse.model,
        usage: {
          input_tokens: sdkResponse.usage?.input_tokens ?? 0,
          output_tokens: sdkResponse.usage?.output_tokens ?? 0,
          cache_read_input_tokens: sdkResponse.usage?.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: sdkResponse.usage?.cache_creation_input_tokens ?? 0,
        },
        used_auth_profile: profileName,
      },
    };
  } catch (err) {
    const sdkError = err as { status?: number; message?: string };
    const httpStatus = typeof sdkError.status === "number" ? sdkError.status : 502;
    const errorType =
      httpStatus === 401 || httpStatus === 403 ? "auth_failed" : "anthropic_call_failed";
    return {
      ok: false,
      httpStatus,
      errorType,
      code: errorType === "auth_failed" ? "anthropic_auth_failed" : "anthropic_call_failed",
      message: formatErrorMessage(err),
    };
  }
}

// ─── Path matcher ────────────────────────────────────────────────────────

export function isLlmTurnPath(pathname: string): boolean {
  return pathname === "/v1/llm_turn";
}
