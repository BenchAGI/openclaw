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

import type { IncomingMessage, ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
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

interface LlmTurnRequest {
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

  // Anthropic call. Resolves the auth credential via env (proper auth-profile
  // machinery integration is a separate sub-PR — see comment block below for the
  // remaining work). Surfaces the resolved profile name back as
  // `used_auth_profile` so the cloud orchestrator (W2) can decide between OAuth
  // and API/coin-mode billing per spec §6.
  const anthropicResult = await callAnthropicForLlmTurn(validation.request);
  if (!anthropicResult.ok) {
    logWarn(
      `[llm_turn] Anthropic call failed for agent=${validation.request.agentId}: ` +
        `${anthropicResult.code} ${anthropicResult.message}`,
    );
    sendJson(res, anthropicResult.httpStatus, {
      error: {
        type: anthropicResult.errorType,
        code: anthropicResult.code,
        message: anthropicResult.message,
      },
    });
    return true;
  }

  sendJson(res, 200, anthropicResult.response);
  return true;
}

// ─── Anthropic call ──────────────────────────────────────────────────────

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

type AnthropicCallSuccess = { ok: true; response: LlmTurnWireResponse };
type AnthropicCallFailure = {
  ok: false;
  httpStatus: number;
  errorType: string;
  code: string;
  message: string;
};
type AnthropicCallResult = AnthropicCallSuccess | AnthropicCallFailure;

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
async function callAnthropicForLlmTurn(request: LlmTurnRequest): Promise<AnthropicCallResult> {
  const { apiKey, profileName, isOAuthToken } = resolveAnthropicCredential();
  if (!apiKey) {
    return {
      ok: false,
      httpStatus: 500,
      errorType: "auth_failed",
      code: "no_anthropic_credential",
      message:
        "OpenClaw has no Anthropic credential available (ANTHROPIC_API_KEY not set). " +
        "Configure the agent's auth profile or set the env var to use /v1/llm_turn.",
    };
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
      model: request.model,
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
