import type { AgentsListResult } from "../api/types.ts";
import { benchAgentDisplayName } from "../lib/agents/bench-agent-identity.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isBenchThemeFamily, type ThemeName } from "./theme.ts";

// Keep the preference data intact, but do not expose the control or mount a
// background layer until the product-accepted implementation is available.
const BENCH_GRAVITY_FABRIC_READY = false;

export function benchFabricEnabled(
  theme: ThemeName,
  backgroundMotion: boolean | undefined,
): boolean {
  return BENCH_GRAVITY_FABRIC_READY && isBenchThemeFamily(theme) && backgroundMotion !== false;
}

export function resolveBenchModeSwitchAgent(
  selectedAgentId: string | null,
  agents: AgentsListResult["agents"] | null | undefined,
  fallbackName: string | undefined,
) {
  const selectedAgent = agents?.find((agent) => normalizeAgentId(agent.id) === selectedAgentId);
  const label = selectedAgent
    ? normalizeAgentLabel(selectedAgent)
    : (fallbackName ?? selectedAgentId ?? "");
  return { id: selectedAgentId, name: benchAgentDisplayName(selectedAgentId, label) };
}
