import { isDeepStrictEqual } from "node:util";
import type { WorkboardLaunchState } from "@openclaw/workboard-contract";
import { assertCanMutateClaimedCard } from "./store-authority.js";
import type { WorkboardMutationScope } from "./store-inputs.js";
import type { WorkboardStore } from "./store.js";

/** Admission retains observed claim authority; accepted workers own their normal run lifecycle. */
export function captureWorkboardLaunchAuthority(params: {
  store: WorkboardStore;
  cardId: string;
  launch: Extract<WorkboardLaunchState, { phase: "prepared" }>;
  scope: WorkboardMutationScope;
  assertOwnerCurrent?: () => void;
}) {
  let pending = true;
  let changed = false;
  const unsubscribe = params.store.subscribeChanges(() => {
    changed = true;
  });
  const assertCurrent = Object.assign(
    () => {
      params.assertOwnerCurrent?.();
      if (pending && changed) {
        throw new Error("Workboard changed during worker admission. Reread and retry.");
      }
    },
    {
      async prepareCurrent() {
        assertCurrent();
        await params.store.reconcileExternalChanges();
        const card = await params.store.get(params.cardId);
        assertCurrent();
        if (!card) {
          throw new Error(`card not found: ${params.cardId}`);
        }
        assertCanMutateClaimedCard(card, params.scope);
        if (
          !isDeepStrictEqual(card.metadata?.automation?.launch, params.launch) ||
          card.execution?.sessionKey !== params.launch.requestedSessionKey ||
          card.execution?.runId !== params.launch.provisionalRunId
        ) {
          throw new Error("Workboard prepared execution changed before worker admission.");
        }
      },
    },
  );
  return {
    assertCurrent,
    release() {
      pending = false;
      unsubscribe();
    },
  };
}
