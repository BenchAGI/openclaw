import { html } from "lit";
import type { AgentsListResult } from "../api/types.ts";
import { benchAgentDisplayName } from "../lib/agents/bench-agent-identity.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isBenchThemeFamily, type ThemeName } from "./theme.ts";

// The current gravity-fabric module is an API-compatible no-op scaffold. Keep
// its browser preference data intact, but do not expose or mount it until the
// product-accepted implementation replaces the scaffold.
const BENCH_GRAVITY_FABRIC_READY = false;

export function benchFabricEnabled(
  theme: ThemeName,
  backgroundMotion: boolean | undefined,
): boolean {
  return BENCH_GRAVITY_FABRIC_READY && isBenchThemeFamily(theme) && backgroundMotion !== false;
}

export function renderBenchGravityFabric(enabled: boolean, theme: string) {
  return html`<bench-gravity-fabric ?enabled=${enabled} theme=${theme}></bench-gravity-fabric>`;
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
