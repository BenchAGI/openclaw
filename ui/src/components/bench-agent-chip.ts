// Agent identity chip for the 9.2 chat header (UI-BRAND-CONTRACT §4.2): a
// 30px pill with the agent's avatar in a rarity ring, name, and role eyebrow.
// Clicking it opens the same agent menu the sidebar identity row opens; the
// sidebar owns that menu, so the chip asks for it over a window event.
import { html, nothing } from "lit";
import { t } from "../i18n/index.ts";
import {
  benchAgentIdentity,
  benchAgentPortraitUrl,
  benchAgentStyle,
} from "../lib/agents/bench-agent-identity.ts";
import { deriveAvatarInitial } from "../lib/avatar.ts";

export const BENCH_AGENT_MENU_TOGGLE_EVENT = "openclaw:bench-agent-menu-toggle";

export type BenchAgentMenuToggleDetail = { trigger: HTMLElement };

export type BenchAgentChipProps = {
  agentId: string | null;
  name: string;
  /** Renderable avatar URL (data: or blob:); same-origin gateway avatars need
   * auth and are left to the sidebar, so the chip falls back to the portrait
   * or the initial. */
  avatarUrl?: string | null;
  /** Gateway-configured description; the Bench role line fills the gap. */
  role?: string | null;
  switcherAvailable?: boolean;
};

export function renderBenchAgentChip(props: BenchAgentChipProps) {
  const identity = benchAgentIdentity(props.agentId);
  const portrait = props.avatarUrl ?? benchAgentPortraitUrl(props.agentId);
  const role = props.role?.trim() || identity?.role || "";
  const menuLabel = props.switcherAvailable ? t("agentChip.switchAgent") : t("agentChip.menuLabel");
  return html`
    <button
      type="button"
      class="bench-agent-chip"
      style=${benchAgentStyle(props.agentId)}
      aria-haspopup="menu"
      aria-label="${props.name} · ${menuLabel}"
      @click=${(event: MouseEvent) => {
        event.stopPropagation();
        window.dispatchEvent(
          new CustomEvent<BenchAgentMenuToggleDetail>(BENCH_AGENT_MENU_TOGGLE_EVENT, {
            detail: { trigger: event.currentTarget as HTMLElement },
          }),
        );
      }}
    >
      <span class="bench-agent-chip__avatar bench-agent-halo" aria-hidden="true">
        ${
          portrait
            ? html`<img src=${portrait} alt="" loading="lazy" decoding="async" />`
            : html`<span class="bench-agent-chip__initial"
                >${deriveAvatarInitial(props.name) || "?"}</span
              >`
        }
      </span>
      <span class="bench-agent-chip__text">
        <span class="bench-agent-chip__name">${props.name}</span>
        ${role ? html`<span class="bench-agent-chip__role bench-eyebrow">${role}</span>` : nothing}
      </span>
    </button>
  `;
}
