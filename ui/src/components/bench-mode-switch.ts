// Vault ↔ App mode switch (UI-BRAND-CONTRACT §5.8). Host sets `mode`; the
// element never guesses. It emits a cancelable `bench-mode-change` before
// navigating a plain link, and owns ⌘1 / ⌘2 while connected because keyboard
// focus inside the Vault's child webview never reaches the host window.
//
// This module is loaded as a deferred chunk (app-root.ts) so the boot bundle
// stays inside the startup budget; the tag renders eagerly and upgrades.
import { html, nothing } from "lit";
import { property } from "lit/decorators.js";
import { t } from "../i18n/index.ts";
import type { BenchMode } from "../lib/bench-mode.ts";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
  matchesShortcutCombo,
} from "../lib/keyboard-shortcut-catalog.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "../styles/bench-mode-switch.css";
import { icons } from "./icons.ts";
import "./tooltip.ts";

export type BenchModeSwitchState = "idle" | "switching" | "disabled";
export type BenchModeChangeDetail = { mode: BenchMode; href: string };

const MODES: readonly BenchMode[] = ["vault", "app"];

function hrefForDisplay(href: string): string {
  return href.replace(/^https?:\/\//u, "").replace(/\/$/u, "");
}

class BenchModeSwitch extends OpenClawLightDomContentsElement {
  @property() mode: BenchMode = "vault";
  @property({ attribute: "vault-href" }) vaultHref = "";
  @property({ attribute: "app-href" }) appHref = "";
  @property({ attribute: "agent-id" }) agentId = "";
  @property({ attribute: "agent-name" }) agentName = "";
  @property({ attribute: "agent-accent" }) agentAccent = "";
  @property({ attribute: "agent-avatar" }) agentAvatar = "";
  @property({ attribute: "state", reflect: true }) switchState: BenchModeSwitchState = "idle";
  @property({ attribute: "disabled-reason" }) disabledReason = "";
  /** Icon-only segments; labels move to aria-label (phone chrome). */
  @property({ type: Boolean, reflect: true }) compact = false;
  /** Navigation seam, replaceable in tests; the Vault host refuses this
   * navigation natively and flips the visible surface itself. */
  @property({ attribute: false }) navigate: (href: string) => void = (href) =>
    window.location.assign(href);

  private switchingTo: BenchMode | null = null;

  override connectedCallback(): void {
    super.connectedCallback();
    window.addEventListener("keydown", this.handleKeydown);
  }

  override disconnectedCallback(): void {
    window.removeEventListener("keydown", this.handleKeydown);
    super.disconnectedCallback();
  }

  private readonly handleKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) {
      return;
    }
    const target = matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appMode, event)
      ? "app"
      : matchesShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.vaultMode, event)
        ? "vault"
        : null;
    if (!target) {
      return;
    }
    event.preventDefault();
    // Already on that side: the chord is a no-op, never a reload.
    if (target !== this.mode) {
      this.requestSwitch(target);
    }
  };

  private hrefFor(mode: BenchMode): string {
    return mode === "app" ? this.appHref : this.vaultHref;
  }

  private requestSwitch(target: BenchMode, event?: Event): void {
    event?.preventDefault();
    const href = this.hrefFor(target);
    if (target === this.mode || this.switchState !== "idle" || !href) {
      return;
    }
    const proceed = this.dispatchEvent(
      new CustomEvent<BenchModeChangeDetail>("bench-mode-change", {
        detail: { mode: target, href },
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    if (!proceed) {
      return;
    }
    this.switchingTo = target;
    this.switchState = "switching";
    this.navigate(href);
  }

  private segmentLabel(mode: BenchMode): string {
    if (this.switchState === "switching" && this.switchingTo === mode) {
      return t(mode === "app" ? "modeSwitch.openingApp" : "modeSwitch.openingVault");
    }
    return t(mode === "app" ? "modeSwitch.app" : "modeSwitch.vault");
  }

  private inactiveTooltip(mode: BenchMode): string {
    const agent = this.agentName || t("modeSwitch.yourAgent");
    if (this.switchState === "disabled") {
      return this.disabledReason || t("modeSwitch.disabledReason");
    }
    const lead = t(mode === "app" ? "modeSwitch.openAppWith" : "modeSwitch.openVaultWith", {
      agent,
    });
    const lands = t(mode === "app" ? "modeSwitch.landsInApp" : "modeSwitch.landsInVault", {
      agent,
    });
    const href = hrefForDisplay(this.hrefFor(mode));
    return href ? `${lead} · ${lands} · ${href}` : `${lead} · ${lands}`;
  }

  private renderSegment(mode: BenchMode) {
    const active = mode === this.mode;
    const label = this.segmentLabel(mode);
    const icon = mode === "app" ? icons.layoutGrid : icons.shield;
    const body = html`
      <span class="bench-mode-switch__icon" aria-hidden="true">${icon}</span>
      <span class="bench-mode-switch__label">${label}</span>
      ${
        active && mode === "vault"
          ? html`<span class="bench-mode-switch__dot" aria-hidden="true"></span>`
          : nothing
      }
    `;
    if (active) {
      return html`<span
        class="bench-mode-switch__segment bench-mode-switch__segment--active"
        aria-current="page"
        aria-label=${this.compact ? label : nothing}
        >${body}</span
      >`;
    }
    if (this.switchState === "disabled") {
      return html`<openclaw-tooltip .content=${this.inactiveTooltip(mode)}>
        <span
          class="bench-mode-switch__segment bench-mode-switch__segment--disabled"
          role="link"
          aria-disabled="true"
          aria-label=${this.compact ? label : nothing}
          tabindex="0"
        >
          ${body}
          <span class="bench-mode-switch__lock" aria-hidden="true">${icons.lock}</span>
        </span>
      </openclaw-tooltip>`;
    }
    const hint = formatKeyboardShortcutCombo(
      mode === "app" ? KEYBOARD_SHORTCUT_COMBOS.appMode : KEYBOARD_SHORTCUT_COMBOS.vaultMode,
    );
    return html`<openclaw-tooltip .content=${this.inactiveTooltip(mode)}>
      <a
        class="bench-mode-switch__segment"
        href=${this.hrefFor(mode)}
        aria-label=${this.compact ? label : nothing}
        @click=${(event: MouseEvent) => this.requestSwitch(mode, event)}
      >
        ${body}
        ${
          this.compact
            ? nothing
            : html`<kbd class="bench-mode-switch__hint" aria-hidden="true">${hint}</kbd>`
        }
      </a>
    </openclaw-tooltip>`;
  }

  override render() {
    const style = this.agentAccent ? `--agent-accent: ${this.agentAccent};` : nothing;
    return html`
      <div
        class="bench-mode-switch bench-mode-switch--${this.switchState}"
        role="group"
        aria-label=${t("modeSwitch.label")}
        data-mode=${this.mode}
        style=${style}
      >
        ${MODES.map((mode) => this.renderSegment(mode))}
        ${
          this.switchState === "switching"
            ? html`<span class="bench-mode-switch__progress" aria-hidden="true"></span>`
            : nothing
        }
      </div>
    `;
  }
}

if (!customElements.get("bench-mode-switch")) {
  customElements.define("bench-mode-switch", BenchModeSwitch);
}

export type { BenchModeSwitch };
