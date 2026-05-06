/**
 * Unit tests for `validateLlmTurnRequest` — pure function, no I/O. The
 * full HTTP integration test (auth + rate limit + handler stage) lands in
 * the W3 follow-up alongside the actual Anthropic call.
 */

import { describe, expect, it } from "vitest";
import { validateLlmTurnRequest } from "./llm-turn-http.js";

const validBody = {
  agent_id: "aurelius",
  system_prompt: "You are Aurelius.",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  model: "claude-opus-4-7",
  max_tokens: 8192,
  idempotency_key: "idem-abc",
};

describe("validateLlmTurnRequest", () => {
  it("accepts the canonical happy-path payload", () => {
    const result = validateLlmTurnRequest(validBody);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.agentId).toBe("aurelius");
      expect(result.request.systemPrompt).toBe("You are Aurelius.");
      expect(result.request.messages).toHaveLength(1);
      expect(result.request.tools).toEqual([]);
      expect(result.request.model).toBe("claude-opus-4-7");
      expect(result.request.maxTokens).toBe(8192);
      expect(result.request.idempotencyKey).toBe("idem-abc");
    }
  });

  it("requires agent_id", () => {
    const { agent_id, ...rest } = validBody;
    void agent_id;
    const result = validateLlmTurnRequest(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({ code: "missing_field", field: "agent_id" });
    }
  });

  it("requires system_prompt as a string (empty string is accepted, missing is not)", () => {
    const result = validateLlmTurnRequest({ ...validBody, system_prompt: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("missing_field");
    }
    const empty = validateLlmTurnRequest({ ...validBody, system_prompt: "" });
    expect(empty.ok).toBe(true);
  });

  it("rejects oversized system_prompt", () => {
    const huge = "x".repeat(256_001);
    const result = validateLlmTurnRequest({ ...validBody, system_prompt: huge });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("oversized_field");
    }
  });

  it("requires non-empty messages array", () => {
    const empty = validateLlmTurnRequest({ ...validBody, messages: [] });
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.error.code).toBe("invalid_field");
    }
    const missing = validateLlmTurnRequest({ ...validBody, messages: undefined });
    expect(missing.ok).toBe(false);
  });

  it("rejects messages with invalid role", () => {
    const result = validateLlmTurnRequest({
      ...validBody,
      messages: [{ role: "system", content: "hi" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("invalid_field");
    }
  });

  it("rejects oversized messages array", () => {
    const oversize = Array.from({ length: 257 }, () => ({
      role: "user",
      content: "hi",
    }));
    const result = validateLlmTurnRequest({ ...validBody, messages: oversize });
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "oversized_field") {
      expect(result.error.field).toBe("messages");
    }
  });

  it("accepts tools with valid input_schema", () => {
    const result = validateLlmTurnRequest({
      ...validBody,
      tools: [
        {
          name: "bash",
          description: "Run a bash command",
          input_schema: { type: "object", properties: { cmd: { type: "string" } } },
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.tools).toHaveLength(1);
      expect(result.request.tools[0].name).toBe("bash");
    }
  });

  it("rejects tool missing input_schema", () => {
    const result = validateLlmTurnRequest({
      ...validBody,
      tools: [{ name: "bash", description: "Run cmd" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("missing_field");
    }
  });

  it("requires model", () => {
    const result = validateLlmTurnRequest({ ...validBody, model: undefined });
    expect(result.ok).toBe(false);
  });

  it("rejects non-positive max_tokens", () => {
    expect(validateLlmTurnRequest({ ...validBody, max_tokens: 0 }).ok).toBe(false);
    expect(validateLlmTurnRequest({ ...validBody, max_tokens: -100 }).ok).toBe(false);
    expect(validateLlmTurnRequest({ ...validBody, max_tokens: "8192" }).ok).toBe(false);
  });

  it("requires idempotency_key", () => {
    const result = validateLlmTurnRequest({ ...validBody, idempotency_key: undefined });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual({
        code: "missing_field",
        field: "idempotency_key",
      });
    }
  });

  it("accepts optional thinking_level", () => {
    const result = validateLlmTurnRequest({ ...validBody, thinking_level: "high" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.thinkingLevel).toBe("high");
    }
  });

  it("accepts optional cache_control with system field", () => {
    const result = validateLlmTurnRequest({
      ...validBody,
      cache_control: { system: "ephemeral" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.cacheControl).toEqual({ system: "ephemeral" });
    }
  });
});
