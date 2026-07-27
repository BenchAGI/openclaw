/**
 * Delivery-truth tests for cron delivery dispatch.
 *
 * Bug class: cron job state reported lastDeliveryStatus=delivered /
 * consecutiveErrors=0 when the channel send was approval-blocked or failed
 * (BenchAGI_Mono_Repo #4200, #4131, #3941). These tests pin the dispatch-side
 * contract: delivery outcomes derive from transport results — a hook-cancelled
 * send surfaces `deliveryBlockedReason`, a bestEffort transport failure
 * surfaces `deliveryFailedError`, and neither ever reads as delivered.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Module mocks (must be hoisted before imports) ---

const {
  appendAssistantMessageToSessionTranscriptMock,
  countActiveDescendantRunsMock,
  deliverOutboundPayloadsMock,
  ensureOutboundSessionEntryMock,
  maybeApplyTtsToPayloadMock,
  retireSessionMcpRuntimeMock,
  resolveOutboundSessionRouteMock,
} = vi.hoisted(() => ({
  appendAssistantMessageToSessionTranscriptMock: vi.fn().mockResolvedValue({
    ok: true,
    sessionFile: "session.jsonl",
    messageId: "mirror-message",
  }),
  countActiveDescendantRunsMock: vi.fn().mockReturnValue(0),
  deliverOutboundPayloadsMock: vi.fn().mockResolvedValue([{ ok: true }]),
  ensureOutboundSessionEntryMock: vi.fn().mockResolvedValue(undefined),
  maybeApplyTtsToPayloadMock: vi.fn(async (params: { payload: unknown }) => params.payload),
  retireSessionMcpRuntimeMock: vi.fn().mockResolvedValue(true),
  resolveOutboundSessionRouteMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  canonicalizeMainSessionAlias: vi.fn(({ sessionKey }: { sessionKey: string }) => sessionKey),
  resolveAgentMainSessionKey: vi.fn(({ agentId }: { agentId: string }) => `agent:${agentId}:main`),
  resolveMainSessionKey: vi.fn(() => "global"),
}));

vi.mock("../../agents/agent-bundle-mcp-tools.js", () => ({
  retireSessionMcpRuntime: retireSessionMcpRuntimeMock,
}));

vi.mock("./delivery-subagent-registry.runtime.js", () => ({
  countActiveDescendantRuns: countActiveDescendantRunsMock,
}));

vi.mock("../../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: deliverOutboundPayloadsMock,
  deliverOutboundPayloadsInternal: deliverOutboundPayloadsMock,
}));

vi.mock("../../infra/outbound/identity.js", () => ({
  resolveAgentOutboundIdentity: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/session-context.js", () => ({
  buildOutboundSessionContext: vi.fn().mockReturnValue({}),
}));

vi.mock("../../infra/outbound/outbound-session.js", () => ({
  ensureOutboundSessionEntry: ensureOutboundSessionEntryMock,
  resolveOutboundSessionRoute: resolveOutboundSessionRouteMock,
}));

vi.mock("../../config/sessions/transcript.runtime.js", () => ({
  appendAssistantMessageToSessionTranscript: appendAssistantMessageToSessionTranscriptMock,
}));

vi.mock("../../cli/outbound-send-deps.js", () => ({
  createOutboundSendDeps: vi.fn().mockReturnValue({}),
}));

vi.mock("../../gateway/call.runtime.js", () => ({
  callGateway: vi.fn().mockResolvedValue({ status: "ok" }),
}));

vi.mock("../../logger.js", () => ({
  logWarn: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("../../infra/system-events.js", () => ({
  enqueueSystemEvent: vi.fn(),
}));

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: maybeApplyTtsToPayloadMock,
}));

vi.mock("./subagent-followup-hints.js", () => ({
  expectsSubagentFollowup: vi.fn().mockReturnValue(false),
  isLikelyInterimCronMessage: vi.fn().mockReturnValue(false),
}));

vi.mock("./subagent-followup.runtime.js", () => ({
  readDescendantSubagentFallbackReply: vi.fn().mockResolvedValue(undefined),
  waitForDescendantSubagentSummary: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
import {
  dispatchCronDelivery,
  resetCompletedDirectCronDeliveriesForTests,
  resolvePolicyBlockedSendReason,
} from "./delivery-dispatch.js";
import type { DeliveryTargetResolution } from "./delivery-target.js";
import type { RunCronAgentTurnResult } from "./run.js";

type SuccessfulDeliveryResolution = Extract<DeliveryTargetResolution, { ok: true }>;

function makeResolvedDelivery(): SuccessfulDeliveryResolution {
  return {
    ok: true,
    channel: "telegram",
    to: "123456",
    accountId: undefined,
    threadId: undefined,
    mode: "explicit",
  };
}

function makeWithRunSession() {
  return (
    result: Omit<RunCronAgentTurnResult, "sessionId" | "sessionKey">,
  ): RunCronAgentTurnResult => ({
    ...result,
    sessionId: "test-session-id",
    sessionKey: "test-session-key",
  });
}

function makeBaseParams(overrides: {
  synthesizedText?: string;
  deliveryBestEffort?: boolean;
}): Parameters<typeof dispatchCronDelivery>[0] {
  const runStartedAt = Date.now();
  return {
    cfg: {} as never,
    cfgWithAgentDefaults: {} as never,
    deps: {} as never,
    job: {
      id: "test-job",
      name: "Test Job",
      sessionTarget: "isolated",
      deleteAfterRun: false,
      payload: { kind: "agentTurn", message: "hello" },
    } as never,
    agentId: "main",
    agentSessionKey: "agent:main",
    runSessionKey: "agent:main",
    sessionId: "test-session-id",
    runStartedAt,
    runEndedAt: runStartedAt,
    timeoutMs: 30_000,
    resolvedDelivery: makeResolvedDelivery(),
    deliveryRequested: true,
    skipHeartbeatDelivery: false,
    sourceDeliveryOutcome: {
      visibleDeliveries: [],
      verifiedMessageToolDelivery: false,
      satisfiesSourceDelivery: false,
      unverifiedMessageToolDelivery: false,
    },
    deliveryBestEffort: overrides.deliveryBestEffort ?? false,
    deliveryPayloadHasStructuredContent: false,
    deliveryPayloads: overrides.synthesizedText ? [{ text: overrides.synthesizedText }] : [],
    synthesizedText: overrides.synthesizedText ?? "weekly report",
    summary: overrides.synthesizedText ?? "weekly report",
    outputText: overrides.synthesizedText ?? "weekly report",
    telemetry: undefined,
    abortSignal: undefined,
    isAborted: () => false,
    abortReason: () => "aborted",
    withRunSession: makeWithRunSession(),
  };
}

describe("resolvePolicyBlockedSendReason", () => {
  it("returns the suppression reason for hook-cancelled sends", () => {
    expect(
      resolvePolicyBlockedSendReason({
        status: "suppressed",
        reason: "cancelled_by_message_sending_hook",
      }),
    ).toBe("cancelled_by_message_sending_hook");
  });

  it("appends the hook cancel reason when present", () => {
    expect(
      resolvePolicyBlockedSendReason({
        status: "suppressed",
        reason: "cancelled_by_reply_payload_sending_hook",
        payloadOutcomes: [
          {
            status: "suppressed",
            hookEffect: { cancelReason: "external disclosure requires approval" },
          },
        ],
      }),
    ).toBe("cancelled_by_reply_payload_sending_hook: external disclosure requires approval");
  });

  it("ignores non-policy suppressions and non-suppressed sends", () => {
    expect(
      resolvePolicyBlockedSendReason({ status: "suppressed", reason: "no_visible_result" }),
    ).toBeUndefined();
    expect(
      resolvePolicyBlockedSendReason({
        status: "sent",
        reason: "cancelled_by_message_sending_hook",
      }),
    ).toBeUndefined();
    expect(resolvePolicyBlockedSendReason({ status: "suppressed" })).toBeUndefined();
  });
});

describe("dispatchCronDelivery — delivery truth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCompletedDirectCronDeliveriesForTests();
    countActiveDescendantRunsMock.mockReturnValue(0);
    resolveOutboundSessionRouteMock.mockResolvedValue(null);
    maybeApplyTtsToPayloadMock.mockImplementation(async (params) => params.payload);
  });

  it("classifies a hook-cancelled send as blocked-by-policy, never delivered", async () => {
    deliverOutboundPayloadsMock.mockImplementationOnce(
      async (params: { onPayloadDeliveryOutcome?: (outcome: unknown) => void }) => {
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "suppressed",
          reason: "cancelled_by_message_sending_hook",
          hookEffect: { cancelReason: "external disclosure requires approval" },
        });
        return [];
      },
    );

    const state = await dispatchCronDelivery(makeBaseParams({ synthesizedText: "weekly report" }));

    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(true);
    expect(state.deliveryBlockedReason).toBe(
      "cancelled_by_message_sending_hook: external disclosure requires approval",
    );
    expect(state.deliveryFailedError).toBeUndefined();
    // A policy block is not a run failure: no error result is synthesized.
    expect(state.result).toBeUndefined();
  });

  it("records a bestEffort transport failure as deliveryFailedError, never delivered", async () => {
    deliverOutboundPayloadsMock.mockImplementationOnce(
      async (params: { onPayloadDeliveryOutcome?: (outcome: unknown) => void }) => {
        // Permanent error: the transient-retry loop must not re-attempt it.
        params.onPayloadDeliveryOutcome?.({
          index: 0,
          status: "failed",
          error: new Error("telegram send failed: chat not found"),
          sentBeforeError: false,
          stage: "platform_send",
        });
        return [];
      },
    );

    const state = await dispatchCronDelivery(
      makeBaseParams({ synthesizedText: "weekly report", deliveryBestEffort: true }),
    );

    expect(state.delivered).toBe(false);
    expect(state.deliveryAttempted).toBe(true);
    expect(state.deliveryBlockedReason).toBeUndefined();
    expect(state.deliveryFailedError).toContain("chat not found");
    // bestEffort keeps the run ok; the failure marker is the health signal.
    expect(state.result).toBeUndefined();
  });

  it("keeps confirmed sends delivered with no failure markers", async () => {
    deliverOutboundPayloadsMock.mockImplementationOnce(
      async (params: { onPayloadDeliveryOutcome?: (outcome: unknown) => void }) => {
        const results = [{ channel: "telegram", messageId: "msg-1" }];
        params.onPayloadDeliveryOutcome?.({ index: 0, status: "sent", results });
        return results;
      },
    );

    const state = await dispatchCronDelivery(makeBaseParams({ synthesizedText: "weekly report" }));

    expect(state.delivered).toBe(true);
    expect(state.deliveryBlockedReason).toBeUndefined();
    expect(state.deliveryFailedError).toBeUndefined();
  });
});
