import {
  startSessionObservabilityBookend,
  stopSessionObservabilityBookend,
  type SessionObservabilityBookend,
  type SessionObservabilityBookendDeps,
} from "../sessions/session-observability-bookend.js";
import {
  startAgentEventsForwarder,
  stopAgentEventsForwarder,
  type AgentEventsForwarder,
  type AgentEventsForwarderDeps,
} from "./agent-events-forwarder.js";

export type AgentObservabilityRuntimeDeps = {
  forwarder?: AgentEventsForwarderDeps;
  bookend?: SessionObservabilityBookendDeps;
};

export type AgentObservabilityRuntime = {
  forwarder: AgentEventsForwarder;
  bookend: SessionObservabilityBookend;
  stop: () => Promise<void>;
};

let activeRuntime: AgentObservabilityRuntime | null = null;

export function startAgentObservabilityRuntime(
  deps: AgentObservabilityRuntimeDeps = {},
): AgentObservabilityRuntime | null {
  if (activeRuntime) {
    return activeRuntime;
  }

  const forwarder = startAgentEventsForwarder(deps.forwarder);
  if (!forwarder) {
    return null;
  }

  const bookend = startSessionObservabilityBookend(deps.bookend);
  activeRuntime = {
    forwarder,
    bookend,
    stop: stopAgentObservabilityRuntime,
  };
  return activeRuntime;
}

export async function stopAgentObservabilityRuntime(): Promise<void> {
  if (!activeRuntime) {
    await stopAgentEventsForwarder();
    stopSessionObservabilityBookend();
    return;
  }
  activeRuntime = null;
  stopSessionObservabilityBookend();
  await stopAgentEventsForwarder({ flush: true });
}

export async function resetAgentObservabilityRuntimeForTest(): Promise<void> {
  activeRuntime = null;
  stopSessionObservabilityBookend();
  await stopAgentEventsForwarder();
}
