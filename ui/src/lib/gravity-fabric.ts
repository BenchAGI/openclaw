/**
 * Gravity fabric — STUB.
 *
 * The real module is BenchAGI/aurelius `apps/aurelius-vault/app/src/gravity-fabric.ts`
 * (v2.2 at 4af74d39 on PR #338; dependency-free Canvas2D ESM). Cory has not
 * yet accepted a head on screen, so the fork carries this API-compatible stub:
 * same exports the wrapper and the Vault consume, a static no-op draw, and
 * honest `stats`. Replacing this file with a verbatim copy of the accepted
 * commit (plus a header naming repo, path, and sha) is the whole of §8's
 * remaining work; nothing else in the fork changes.
 */

export type FabricTheme = "dark" | "light";

export interface GravityFabricOptions {
  theme: FabricTheme;
  pointerTarget: Window | HTMLElement;
  reducedMotion?: boolean;
  readTokens?: (theme: FabricTheme) => FabricTokens;
}

export interface GravityFabricHandle {
  destroy(): void;
  setTheme(theme: FabricTheme): void;
  readonly stats: FabricStats;
}

export interface FabricTokens {
  bg: string;
  ir: string;
}

export interface FabricStats {
  frames: number;
  averageFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  fps: number;
  cells: number;
  lines: number;
  rings: number;
  trails: boolean;
  mode: "static" | "live" | "paused" | "destroyed";
}

const FALLBACK_TOKENS: Record<FabricTheme, FabricTokens> = {
  dark: { bg: "#0a0a0c", ir: "#ff2d55" },
  light: { bg: "#fafaf7", ir: "#d40f3f" },
};

/** `--bg` and `--brand-bench` off the active theme, with the Bench defaults as fallback. */
export function defaultTokens(
  theme: FabricTheme,
  root: Element | null = globalThis.document?.documentElement ?? null,
): FabricTokens {
  const fallback = FALLBACK_TOKENS[theme];
  if (!root || typeof getComputedStyle !== "function") {
    return fallback;
  }
  const styles = getComputedStyle(root);
  return {
    bg: styles.getPropertyValue("--bg").trim() || fallback.bg,
    ir: styles.getPropertyValue("--brand-bench").trim() || fallback.ir,
  };
}

/**
 * Stub mount: sizes the canvas once, paints nothing, and reports `mode:
 * "static"`. Harmless without a 2D context (the real module makes the same
 * promise). The accepted module replaces this body verbatim.
 */
export function mountGravityFabric(
  canvas: HTMLCanvasElement,
  options: GravityFabricOptions,
): GravityFabricHandle {
  const readTokens = options.readTokens ?? defaultTokens;
  let theme = options.theme;
  let tokens = readTokens(theme);
  const stats: FabricStats = {
    frames: 0,
    averageFrameMs: 0,
    p50FrameMs: 0,
    p95FrameMs: 0,
    fps: 0,
    cells: 0,
    lines: 0,
    rings: 0,
    trails: false,
    mode: "static",
  };
  const paint = () => {
    const context = canvas.getContext?.("2d");
    if (!context) {
      return;
    }
    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = canvas.clientWidth || 1;
    const height = canvas.clientHeight || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    context.clearRect(0, 0, canvas.width, canvas.height);
    void tokens;
  };
  paint();
  return {
    destroy() {
      stats.mode = "destroyed";
    },
    setTheme(next: FabricTheme) {
      theme = next;
      tokens = readTokens(theme);
      if (stats.mode !== "destroyed") {
        paint();
      }
    },
    get stats() {
      return stats;
    },
  };
}
