// Tests the persistent fallback-mode banner built from the merged execution trace.
import { describe, expect, it } from "vitest";
import { getReplyPayloadMetadata, setReplyPayloadMetadata } from "../reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import { buildFallbackModeNotice, prependFallbackModeNotice } from "./fallback-mode-notice.js";

describe("buildFallbackModeNotice", () => {
  it("returns no notice when the primary provider answered", () => {
    expect(
      buildFallbackModeNotice({
        executionTrace: {
          winnerProvider: "anthropic",
          winnerModel: "claude-opus-4-8",
          attempts: [
            {
              provider: "anthropic",
              model: "claude-opus-4-8",
              result: "success",
            },
          ],
          fallbackUsed: false,
        },
        requestedProvider: "anthropic",
      }),
    ).toBeUndefined();
  });

  it("returns no notice when fallback stayed within the requested provider", () => {
    expect(
      buildFallbackModeNotice({
        executionTrace: {
          winnerProvider: "anthropic",
          winnerModel: "claude-sonnet-4-6",
          attempts: [
            {
              provider: "anthropic",
              model: "claude-opus-4-8",
              result: "candidate_failed",
              reason: "overloaded",
            },
            {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              result: "success",
            },
          ],
          fallbackUsed: true,
        },
        requestedProvider: "anthropic",
      }),
    ).toBeUndefined();
  });

  it("returns no notice when the trace is missing", () => {
    expect(
      buildFallbackModeNotice({
        executionTrace: undefined,
        requestedProvider: "anthropic",
      }),
    ).toBeUndefined();
  });

  it("includes winner provider/model and the last failure reason after a fallback win", () => {
    expect(
      buildFallbackModeNotice({
        executionTrace: {
          winnerProvider: "openai",
          winnerModel: "gpt-5.4",
          attempts: [
            {
              provider: "anthropic",
              model: "claude-opus-4-8",
              result: "candidate_failed",
              reason: "rate_limit",
              status: 429,
            },
            { provider: "openai", model: "gpt-5.4", result: "success" },
          ],
          fallbackUsed: true,
        },
        requestedProvider: "anthropic",
      }),
    ).toBe("⚠ running in fallback mode (openai/gpt-5.4 — rate limit)");
  });

  it("falls back to HTTP status when the failed attempt has no reason", () => {
    expect(
      buildFallbackModeNotice({
        executionTrace: {
          winnerProvider: "ollama",
          winnerModel: "qwen2.5:7b-instruct",
          attempts: [
            {
              provider: "anthropic",
              model: "claude-opus-4-8",
              result: "candidate_failed",
              status: 529,
            },
            {
              provider: "ollama",
              model: "qwen2.5:7b-instruct",
              result: "success",
            },
          ],
          fallbackUsed: true,
        },
        requestedProvider: "anthropic",
      }),
    ).toBe("⚠ running in fallback mode (ollama/qwen2.5:7b-instruct — HTTP 529)");
  });

  it("uses active fallback state for sticky fallback turns without a fresh failure", () => {
    expect(
      buildFallbackModeNotice({
        executionTrace: {
          winnerProvider: "deepinfra",
          winnerModel: "moonshotai/Kimi-K2.5",
          attempts: [
            {
              provider: "deepinfra",
              model: "moonshotai/Kimi-K2.5",
              result: "success",
            },
          ],
          fallbackUsed: false,
        },
        requestedProvider: "fireworks",
        fallbackActive: true,
        fallbackReason: "rate limit",
      }),
    ).toBe("⚠ running in fallback mode (deepinfra/moonshotai/Kimi-K2.5 — rate limit)");
  });
});

describe("prependFallbackModeNotice", () => {
  const notice = "⚠ running in fallback mode (openai/gpt-5.4 — rate limit)";

  it("prepends the banner to the first visible answer payload", () => {
    const updated = prependFallbackModeNotice(
      [
        { text: "↪️ Model Fallback: openai/gpt-5.4", isFallbackNotice: true },
        { text: "the actual answer" },
        { text: "trailing payload" },
      ],
      notice,
    );

    expect(updated[0]).toEqual({
      text: "↪️ Model Fallback: openai/gpt-5.4",
      isFallbackNotice: true,
    });
    expect(updated[1]).toEqual({ text: `${notice}\n\nthe actual answer` });
    expect(updated[2]).toEqual({ text: "trailing payload" });
  });

  it("skips silent and reasoning payloads and leaves them untouched", () => {
    const payloads = [
      { text: SILENT_REPLY_TOKEN },
      { text: "hidden reasoning", isReasoning: true },
    ];

    expect(prependFallbackModeNotice(payloads, notice)).toEqual(payloads);
  });

  it("preserves payload metadata and mirrors the mutated text", () => {
    const payload = setReplyPayloadMetadata(
      { text: "answer" },
      {
        deliverDespiteSourceReplySuppression: true,
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main:telegram:direct:123",
          agentId: "main",
          text: "answer",
          idempotencyKey: "run-1:internal-source-reply:0",
        },
      },
    );

    const [updated] = prependFallbackModeNotice([payload], notice);

    expect(updated).toEqual({ text: `${notice}\n\nanswer` });
    if (!updated) {
      throw new Error("expected the prepended payload");
    }
    expect(getReplyPayloadMetadata(updated)).toMatchObject({
      deliverDespiteSourceReplySuppression: true,
      sourceReplyTranscriptMirror: {
        sessionKey: "agent:main:telegram:direct:123",
        idempotencyKey: "run-1:internal-source-reply:0",
        text: `${notice}\n\nanswer`,
      },
    });
  });
});
