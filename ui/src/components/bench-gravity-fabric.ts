// Fork host for the gravity fabric (UI-BRAND-CONTRACT §8.5): one fixed,
// pointer-transparent canvas under the shell, mounted only while the host says
// `enabled` (a Bench family is active and "Background motion" is on), themed
// from the resolved mode, and remounted static when the OS asks for reduced
// motion. This module is a deferred chunk (app-root.ts); the tag renders in
// the shell at boot and upgrades when the chunk lands.
import { html, type PropertyValues } from "lit";
import { property } from "lit/decorators.js";
import {
  type FabricTheme,
  type GravityFabricHandle,
  mountGravityFabric,
} from "../lib/gravity-fabric.ts";
import { OpenClawLightDomContentsElement } from "../lit/openclaw-element.ts";
import "../styles/bench-gravity-fabric.css";

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

class BenchGravityFabric extends OpenClawLightDomContentsElement {
  /** Host gate: Bench family active and the Appearance toggle on. */
  @property({ type: Boolean, reflect: true }) enabled = false;
  /** Resolved theme mode; forwarded to the module on change. */
  @property() theme: FabricTheme = "dark";
  /** Mount seam, replaceable in tests. */
  @property({ attribute: false }) mount: typeof mountGravityFabric = mountGravityFabric;

  private handle: GravityFabricHandle | null = null;
  private motionQuery: MediaQueryList | null = null;

  get stats() {
    return this.handle?.stats ?? null;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.motionQuery = globalThis.matchMedia?.(REDUCED_MOTION_QUERY) ?? null;
    this.motionQuery?.addEventListener?.("change", this.handleMotionChange);
  }

  override disconnectedCallback(): void {
    this.motionQuery?.removeEventListener?.("change", this.handleMotionChange);
    this.motionQuery = null;
    this.unmount();
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues<this>): void {
    super.updated(changed);
    if (changed.has("enabled")) {
      this.sync();
    }
    if (changed.has("theme") && this.handle) {
      this.handle.setTheme(this.theme);
    }
  }

  // Reduced motion flips between the live loop and one static draw; the module
  // owns that switch, so remount with the new preference.
  private readonly handleMotionChange = () => {
    if (this.handle) {
      this.unmount();
      this.sync();
    }
  };

  private sync(): void {
    if (this.enabled && this.isConnected) {
      this.mountFabric();
    } else {
      this.unmount();
    }
  }

  private mountFabric(): void {
    if (this.handle) {
      return;
    }
    const canvas = this.querySelector<HTMLCanvasElement>("canvas.bench-gravity-fabric");
    if (!canvas) {
      return;
    }
    this.handle = this.mount(canvas, {
      theme: this.theme,
      pointerTarget: window,
      reducedMotion: this.motionQuery?.matches ?? false,
    });
  }

  private unmount(): void {
    this.handle?.destroy();
    this.handle = null;
  }

  override render() {
    return html`<canvas class="bench-gravity-fabric" aria-hidden="true"></canvas>`;
  }
}

if (!customElements.get("bench-gravity-fabric")) {
  customElements.define("bench-gravity-fabric", BenchGravityFabric);
}

export type { BenchGravityFabric };
