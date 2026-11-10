import type { WorkboardCard } from "@openclaw/workboard-contract";
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { workboardSessionKeyForCard } from "./session-link.js";
import { isWorkboardClaimReclaimable } from "./store-constants.js";
import type { WorkboardWorkerScope } from "./store-inputs.js";

function workerSessionKey(sessionKey: string, agentId: string): string | undefined {
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed && parsed.agentId !== agentId) {
    return undefined;
  }
  const rest = parsed?.rest ?? sessionKey;
  return rest.startsWith("subagent:workboard-") ? `agent:${agentId}:${rest}` : undefined;
}

export function workboardWorkerScopeForCard(
  context: OpenClawPluginToolContext | undefined,
  card: WorkboardCard,
): WorkboardWorkerScope | undefined {
  const sessionKey = context?.sessionKey?.trim();
  if (!sessionKey || !/(?:^|:)subagent:workboard-/i.test(sessionKey)) {
    return undefined;
  }
  const launch = card.metadata?.automation?.launch;
  if (
    !context?.assertInvocationCurrent ||
    !context.agentId ||
    !launch ||
    launch.phase === "failed"
  ) {
    throw new Error("Workboard worker has no current launch authority.");
  }
  const agentId = normalizeAgentId(context.agentId);
  const assignedAgentId = card.agentId ? normalizeAgentId(card.agentId) : undefined;
  // Assigned workers already have an explicit owner; only unassigned dispatch resolves a default.
  const expectedAgentId =
    assignedAgentId ?? normalizeAgentId(resolveDefaultAgentId(context.config ?? {}));
  if (agentId !== expectedAgentId) {
    throw new Error("Workboard worker does not match the card agent.");
  }
  return {
    cardId: card.id,
    agentId,
    assignedAgentId,
    sessionKey,
    launch: { ...launch },
    assertInvocationCurrent: context.assertInvocationCurrent,
  };
}

/** Check current persisted association, not the permissive legacy lifecycle correlation. */
export function assertWorkboardWorkerCard(card: WorkboardCard, worker: WorkboardWorkerScope) {
  worker.assertInvocationCurrent();
  const launch = card.metadata?.automation?.launch;
  const claim = card.metadata?.claim;
  const execution = card.execution;
  if (
    card.id !== worker.cardId ||
    !claim ||
    isWorkboardClaimReclaimable(claim, Date.now()) ||
    !launch ||
    launch.phase === "failed" ||
    launch.requestedSessionKey !== worker.launch.requestedSessionKey ||
    launch.provisionalRunId !== worker.launch.provisionalRunId ||
    launch.preparedAt !== worker.launch.preparedAt ||
    (worker.launch.phase === "accepted" &&
      (launch.phase !== "accepted" ||
        launch.acceptedSessionKey !== worker.launch.acceptedSessionKey ||
        launch.acceptedRunId !== worker.launch.acceptedRunId ||
        launch.acceptedAt !== worker.launch.acceptedAt)) ||
    (card.agentId ? normalizeAgentId(card.agentId) : undefined) !== worker.assignedAgentId ||
    execution?.kind !== "agent-session"
  ) {
    throw new Error("Workboard worker card authority changed or is unavailable.");
  }
  const expectedSession = workerSessionKey(workboardSessionKeyForCard(card), worker.agentId);
  const sessionKey =
    launch.phase === "accepted" ? launch.acceptedSessionKey : launch.requestedSessionKey;
  const runId =
    launch.phase === "accepted"
      ? (launch.acceptedRunId ?? launch.provisionalRunId)
      : launch.provisionalRunId;
  if (
    !expectedSession ||
    workerSessionKey(worker.sessionKey, worker.agentId) !== expectedSession ||
    workerSessionKey(launch.requestedSessionKey, worker.agentId) !== expectedSession ||
    workerSessionKey(sessionKey, worker.agentId) !== expectedSession ||
    workerSessionKey(card.sessionKey ?? "", worker.agentId) !== expectedSession ||
    workerSessionKey(execution.sessionKey ?? "", worker.agentId) !== expectedSession ||
    card.runId !== runId ||
    (execution.runId ??
      (launch.phase === "accepted" && !launch.acceptedRunId ? runId : undefined)) !== runId
  ) {
    throw new Error("Workboard worker does not match the current card execution.");
  }
}
