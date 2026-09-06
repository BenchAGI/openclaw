/**
 * Delivery-truth tests for cron delivery dispatch (Bench fork #100).
 *
 * Bug class: cron job state reported lastDeliveryStatus=delivered /
 * consecutiveErrors=0 when the channel send was approval-blocked or failed
 * (BenchAGI_Mono_Repo #4200, #4131, #3941). On the 2026.9.2 runtime the
 * dispatch outcome is carried by `deliveryState` (status / error /
 * deliveryFailedError); this file pins the policy-gate classifier, and
 * `service.persists-delivered-status.test.ts` pins the job-state contract
 * (blocked-by-policy is terminal and never delivered; an unconfirmed
 * bestEffort send counts as a consecutive error).
 */

import { describe, expect, it } from "vitest";
import { resolvePolicyBlockedSendReason } from "./delivery-dispatch.js";

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
