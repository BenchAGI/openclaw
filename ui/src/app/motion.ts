// Motion budget: whether the Control UI runs its ambient animation or stays calm.
import type { MotionPreference } from "./settings.ts";

export type MotionPresentation = "full" | "reduced";

export type MotionEnvironment = {
  /** The OS-level `prefers-reduced-motion: reduce` media query matches. */
  prefersReducedMotion: boolean;
  /** The document is hosted by a native app shell's WKWebView (the Aurelius Vault). */
  embeddedHost: boolean;
};

// An explicit host marker a native shell can append to its webview user agent.
const EMBEDDED_HOST_TOKEN = /\bAureliusVault\//u;
const WEBKIT_TOKEN = /AppleWebKit\//u;
// Every full browser adds a product token after AppleWebKit; a bare WKWebView
// (Tauri/wry, native app shells) identifies as AppleWebKit alone.
const BROWSER_PRODUCT_TOKEN = /(?:Safari|Chrome|Chromium|CriOS|FxiOS|Firefox|Edg|Electron)\//u;

export function isEmbeddedWebKitHost(userAgent: string): boolean {
  if (EMBEDDED_HOST_TOKEN.test(userAgent)) {
    return true;
  }
  return WEBKIT_TOKEN.test(userAgent) && !BROWSER_PRODUCT_TOKEN.test(userAgent);
}

export function readMotionEnvironment(): MotionEnvironment {
  const prefersReducedMotion =
    typeof globalThis.matchMedia === "function" &&
    globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  const userAgent = typeof navigator === "undefined" ? "" : (navigator.userAgent ?? "");
  return { prefersReducedMotion, embeddedHost: isEmbeddedWebKitHost(userAgent) };
}

/**
 * "auto" stays calm inside a native app shell and under the OS preference;
 * "full" keeps the UI's own ambient motion (the OS media query still applies
 * to rules scoped to it); "reduced" is calm everywhere.
 */
export function resolveMotionPresentation(
  preference: MotionPreference | undefined,
  environment: MotionEnvironment,
): MotionPresentation {
  switch (preference) {
    case "full":
      return "full";
    case "reduced":
      return "reduced";
    default:
      return environment.prefersReducedMotion || environment.embeddedHost ? "reduced" : "full";
  }
}

// styles/motion.css and the pre-paint stamp in index.html select on this attribute.
export function applyMotionPresentation(root: HTMLElement, presentation: MotionPresentation): void {
  root.dataset.motion = presentation;
}

/** Whether a script-driven loop (canvas, rAF) should hold its static pose. */
export function calmMotionRequested(): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  return (
    document.documentElement.dataset.motion === "reduced" ||
    (typeof globalThis.matchMedia === "function" &&
      globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches === true)
  );
}

export function currentMotion(preference: MotionPreference | undefined): MotionPresentation {
  return resolveMotionPresentation(preference, readMotionEnvironment());
}

let syncedRoot: HTMLElement | null = null;
let syncedPreference: MotionPreference | undefined;
let osListenerInstalled = false;

/**
 * Stamps the resolved budget on the root and keeps it current when the OS
 * preference flips mid-session. The media listener is installed once per
 * document and re-applies against the last synced preference.
 */
export function syncMotion(root: HTMLElement, preference: MotionPreference | undefined): void {
  syncedRoot = root;
  syncedPreference = preference;
  applyMotionPresentation(root, currentMotion(preference));
  if (osListenerInstalled || typeof globalThis.matchMedia !== "function") {
    return;
  }
  const mediaQuery = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
  const onChange = () => {
    if (syncedRoot) {
      applyMotionPresentation(syncedRoot, currentMotion(syncedPreference));
    }
  };
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onChange);
    osListenerInstalled = true;
  } else if (typeof mediaQuery.addListener === "function") {
    mediaQuery.addListener(onChange);
    osListenerInstalled = true;
  }
}
