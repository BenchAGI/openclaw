// Eager, dependency-light template for <bench-mode-switch> (UI-BRAND-CONTRACT
// §5.8). Surfaces render the tag with its attributes at boot; the element
// module itself is a deferred chunk (see app-root.ts), so this file must not
// import it.
import { html } from "lit";
import { ifDefined } from "lit/directives/if-defined.js";
import { benchAgentIdentity } from "../lib/agents/bench-agent-identity.ts";
import { benchAppHref, benchVaultHref } from "../lib/bench-mode.ts";

export type BenchModeSwitchAgent = {
  id: string | null;
  name: string;
  avatarUrl?: string | null;
};

export function renderBenchModeSwitch(
  agent: BenchModeSwitchAgent,
  options: { compact?: boolean; className?: string } = {},
) {
  const identity = benchAgentIdentity(agent.id);
  return html`<bench-mode-switch
    class=${ifDefined(options.className)}
    mode="vault"
    vault-href=${benchVaultHref()}
    app-href=${benchAppHref(agent.id)}
    agent-id=${agent.id ?? ""}
    agent-name=${agent.name}
    agent-accent=${identity?.accent ?? ""}
    agent-avatar=${ifDefined(agent.avatarUrl ?? undefined)}
    ?compact=${options.compact === true}
  ></bench-mode-switch>`;
}
