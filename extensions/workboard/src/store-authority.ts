import { isDeepStrictEqual } from "node:util";
import type { WorkboardCard } from "@openclaw/workboard-contract";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardMutationScope, WorkboardStartGuard } from "./store-inputs.js";
import { assertWorkboardWorkerCard } from "./tools-worker-scope.js";

export function assertCanMutateClaimedCard(
  card: WorkboardCard,
  scope: WorkboardMutationScope | undefined,
) {
  if (!scope) {
    return;
  }
  if (scope.worker) {
    assertWorkboardWorkerCard(card, scope.worker);
  }
  const claim = card.metadata?.claim;
  const token = normalizeOptionalString(scope.token);
  if (!claim) {
    if (token) {
      throw new Error("card is no longer claimed.");
    }
    return;
  }
  // An agent identity survives takeover; only the current attempt's token fences it.
  if (!safeEqualSecret(token, claim.token)) {
    throw new Error(`card is claimed by ${claim.ownerId}.`);
  }
}

export function assertCanLinkClaimedCards(
  parent: WorkboardCard,
  child: WorkboardCard,
  scope: WorkboardMutationScope | undefined,
): void {
  assertCanMutateClaimedCard(parent, scope);
  // A parent's token does not become a stale child token; a claimed child needs its own token.
  const childScope = scope && !child.metadata?.claim ? { ownerId: scope.ownerId } : scope;
  assertCanMutateClaimedCard(child, childScope);
}

export function assertWorkboardStartGuard(card: WorkboardCard, guard: WorkboardStartGuard) {
  if (card.updatedAt !== guard.expectedUpdatedAt) {
    throw new Error("card version changed before start; reread the card before retrying.");
  }
  const authority = {
    boardId: cardBoardId(card),
    agentId: card.agentId,
    tenant: card.metadata?.automation?.tenant,
    workspace: card.metadata?.automation?.workspace,
    maxRuntimeSeconds: card.metadata?.automation?.maxRuntimeSeconds,
  };
  if (card.status !== "ready" || !isDeepStrictEqual(authority, guard.expectedAuthority)) {
    throw new Error("card start authority changed; reread the ready card before retrying.");
  }
}
