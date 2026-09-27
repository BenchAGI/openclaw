import { html } from "lit";
import type { AgentsListResult } from "../api/types.ts";
import { benchAgentDisplayName } from "../lib/agents/bench-agent-identity.ts";
import { normalizeAgentLabel } from "../lib/agents/display.ts";
import { normalizeAgentId } from "../lib/sessions/session-key.ts";
import { isBenchThemeFamily, type ThemeName } from "./theme.ts";

// The desktop Vault stamps this on <html> before any page script runs
// (BenchAGI/aurelius app_ingress / openclaw_ingress). Inside it the Vault's own
// gravity fabric is the one live loop: the embedded shell keeps its background
// still and hides the toggle rather than drifting a second field under the first.
const VAULT_HOST = "aurelius-vault";

function hostedInVault(): boolean {
  return globalThis.document?.documentElement.dataset.benchHost === VAULT_HOST;
}

// Whether the fabric can run here at all: a Bench family, outside the Vault.
// The Appearance toggle keys on this, not on its own value, so switching it
// off never hides the control that turns it back on.
export function benchFabricAvailable(theme: ThemeName): boolean {
  return isBenchThemeFamily(theme) && !hostedInVault();
}

export function benchFabricEnabled(
  theme: ThemeName,
  backgroundMotion: boolean | undefined,
): boolean {
  return benchFabricAvailable(theme) && backgroundMotion !== false;
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
