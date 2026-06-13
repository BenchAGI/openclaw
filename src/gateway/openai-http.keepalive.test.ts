import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { testOnlyOpenAiHttp } from "./openai-http.js";

const { resolveOpenAiChatCompletionsLimits } = testOnlyOpenAiHttp;

// Full-agent runs emit no assistant deltas while tools execute, so consumers
// of /v1/chat/completions SSE need periodic keepalive comment frames to hold
// a short liveness timeout instead of a turn-length deadline. These tests pin
// the config resolution; the timer itself lives in the streaming handler and
// writes `: keepalive\n\n` frames that spec-compliant SSE clients ignore.
describe("chat-completions SSE keepalive config", () => {
  it("defaults to 15s when unset", () => {
    expect(resolveOpenAiChatCompletionsLimits(undefined).sseKeepaliveIntervalMs).toBe(15_000);
    expect(resolveOpenAiChatCompletionsLimits({}).sseKeepaliveIntervalMs).toBe(15_000);
  });

  it("honors an explicit interval", () => {
    expect(
      resolveOpenAiChatCompletionsLimits({ sseKeepaliveIntervalMs: 5_000 }).sseKeepaliveIntervalMs,
    ).toBe(5_000);
  });

  it("treats 0 as disabled (no timer is started for non-positive intervals)", () => {
    expect(
      resolveOpenAiChatCompletionsLimits({ sseKeepaliveIntervalMs: 0 }).sseKeepaliveIntervalMs,
    ).toBe(0);
  });

  it("clamps to timer-safe bounds and falls back to the default for NaN", () => {
    // Shared resolveIntegerOption semantics: out-of-range clamps to min.
    expect(
      resolveOpenAiChatCompletionsLimits({ sseKeepaliveIntervalMs: -1 }).sseKeepaliveIntervalMs,
    ).toBe(0);
    expect(
      resolveOpenAiChatCompletionsLimits({
        sseKeepaliveIntervalMs: MAX_TIMER_TIMEOUT_MS + 1,
      }).sseKeepaliveIntervalMs,
    ).toBe(MAX_TIMER_TIMEOUT_MS);
    expect(
      resolveOpenAiChatCompletionsLimits({
        sseKeepaliveIntervalMs: Number.NaN,
      }).sseKeepaliveIntervalMs,
    ).toBe(15_000);
  });
});
