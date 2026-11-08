import type { WorkboardCard } from "@openclaw/workboard-contract";
import { jsonResult, readStringParam } from "openclaw/plugin-sdk/core";
import { asRecord, readStringValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import { Type, type TProperties } from "typebox";
import { redactClaimToken } from "./card-redaction.js";
import { assertCanMutateClaimedCard } from "./store-authority.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import type { WorkboardStore } from "./store.js";

type WorkboardCardMutation = (
  id: string,
  record: Record<string, unknown>,
  scope: WorkboardMutationScope,
) => Promise<WorkboardCard>;

export function createWorkboardCardMutations(store: WorkboardStore, ownerId: string) {
  const readParams = async (rawParams: unknown, requireClaim = false) => {
    const record = asRecord(rawParams);
    const id = readStringParam(record, "id", { required: true });
    const token = readStringValue(record.token);
    const card = await store.get(id);
    if (!card) {
      throw new Error(`card not found: ${id}`);
    }
    const claim = card.metadata?.claim;
    const scope = { ownerId, token };
    assertCanMutateClaimedCard(card, scope);
    if (requireClaim && !claim) {
      throw new Error("card must be claimed before lifecycle completion.");
    }
    return { record, id, scope };
  };
  const cardMutation =
    (mutate: WorkboardCardMutation, requireClaim = false) =>
    async (_toolCallId: string, rawParams: unknown) => {
      const { record, id, scope } = await readParams(rawParams, requireClaim);
      // Nest cards so their status cannot be mistaken for the tool result's status.
      return jsonResult({ card: redactClaimToken(await mutate(id, record, scope)) });
    };
  return {
    readScopedCardToolParams: (rawParams: unknown) => readParams(rawParams),
    scopedCardMutation: cardMutation,
    claimedCardMutation: (mutate: WorkboardCardMutation) => cardMutation(mutate, true),
  };
}

export function cardIdField() {
  return Type.String({ description: "Workboard card id." });
}

export function claimTokenField(
  description = "Current claim token from workboard_claim or the dispatched worker prompt; required for claimed cards, including same-agent attempts.",
) {
  return Type.Optional(Type.String({ description }));
}

export function strictObject<const Properties extends TProperties>(properties: Properties) {
  return Type.Object(properties, { additionalProperties: false });
}

export function workspaceField() {
  return Type.Optional(
    strictObject({
      kind: Type.String({ description: "scratch, dir, or worktree." }),
      path: Type.Optional(Type.String({ description: "Absolute dir/worktree path." })),
      branch: Type.Optional(
        Type.String({
          description:
            "Optional worktree source base ref. Re-dispatch reuses a retained checkout; use a new card for a different base ref.",
        }),
      ),
    }),
  );
}
