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
export function validateLlmTurnRequest(body: LlmTurnWireRequest): LlmTurnValidationResult {
  const agentId = normalizeOptionalString(body.agent_id);
  if (!agentId) {
    return { ok: false, error: { code: "missing_field", field: "agent_id" } };
  }

  const systemPrompt = typeof body.system_prompt === "string" ? body.system_prompt : null;
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

  if (!Array.isArray(body.messages)) {
    return { ok: false, error: { code: "missing_field", field: "messages" } };
  }
  if (body.messages.length === 0) {
    return {
      ok: false,
      error: {
        code: "invalid_field",
        field: "messages",
        reason: "must contain at least one message",
      },
    };
  }
  if (body.messages.length > MAX_MESSAGES_LENGTH) {
    return {
      ok: false,
      error: {
        code: "oversized_field",
        field: "messages",
        limit: MAX_MESSAGES_LENGTH,
        actual: body.messages.length,
      },
    };
  }
  const messages: LlmTurnRequest["messages"] = [];
  for (let i = 0; i < body.messages.length; i++) {
    const m = body.messages[i] as { role?: unknown; content?: unknown };
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
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) {
      return {
        ok: false,
        error: { code: "invalid_field", field: "tools", reason: "must be an array" },
      };
    }
    if (body.tools.length > MAX_TOOLS_LENGTH) {
      return {
        ok: false,
        error: {
          code: "oversized_field",
          field: "tools",
          limit: MAX_TOOLS_LENGTH,
          actual: body.tools.length,
        },
      };
    }
    for (let i = 0; i < body.tools.length; i++) {
      const t = body.tools[i] as {
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

  const model = normalizeOptionalString(body.model);
  if (!model) {
    return { ok: false, error: { code: "missing_field", field: "model" } };
  }

  const thinkingLevel = normalizeOptionalString(body.thinking_level) ?? undefined;

  const maxTokensRaw = body.max_tokens;
  if (typeof maxTokensRaw !== "number" || !Number.isFinite(maxTokensRaw) || maxTokensRaw <= 0) {
    return {
      ok: false,
      error: { code: "invalid_field", field: "max_tokens", reason: "must be a positive number" },
    };
  }
  const maxTokens = Math.floor(maxTokensRaw);

  const cacheControl =
    body.cache_control && typeof body.cache_control === "object"
      ? (body.cache_control as { system?: unknown })
      : undefined;
  const cacheControlNormalized = cacheControl
    ? { system: normalizeOptionalString(cacheControl.system) ?? undefined }
    : undefined;

  const idempotencyKey = normalizeOptionalString(body.idempotency_key);
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

  // CALL_ANTHROPIC_TODO (Phase 1B W3 follow-up):
  //   1. Resolve the agent's local Anthropic auth profile via existing
  //      OpenClaw `agents/auth-profiles` machinery.
  //   2. Translate `validation.request` to Anthropic SDK params:
  //      - `messages` → SDK MessageParam[]
  //      - `system_prompt` → SDK system param (with cache_control if requested)
  //      - `tools` → SDK tools[]
  //      - `thinking_level` → SDK thinking config via existing helper
  //   3. Apply `anthropic-payload-policy.ts` cache-control + payload normalization.
  //   4. Optional write-ahead idempotency record keyed by
  //      `validation.request.idempotencyKey` so a relay restart mid-call can
  //      recover the result without re-billing the customer (spec §7 line 851).
  //   5. Call Anthropic SDK + await the response.
  //   6. Translate response (camelCase → snake_case wire format):
  //        content, stop_reason, model, usage, used_auth_profile.
  //   7. Return `sendJson(res, 200, response)`.
  //
  // For now this scaffold returns 501 so the relay claim path can land and
  // exercise the route registration end-to-end without burning customer tokens.
  logWarn(
    `[llm_turn] received valid request for agent=${validation.request.agentId} ` +
      `model=${validation.request.model} messages=${validation.request.messages.length} ` +
      `tools=${validation.request.tools.length} but Anthropic call is not yet implemented`,
  );
  sendJson(res, 501, {
    error: {
      type: "not_implemented",
      code: "llm_turn_not_implemented",
      message:
        "POST /v1/llm_turn route is wired and validates the request body, " +
        "but the Anthropic call path is not yet implemented. See " +
        "CALL_ANTHROPIC_TODO in src/gateway/llm-turn-http.ts.",
    },
  });
  return true;
}

// ─── Path matcher ────────────────────────────────────────────────────────

export function isLlmTurnPath(pathname: string): boolean {
  return pathname === "/v1/llm_turn";
}
