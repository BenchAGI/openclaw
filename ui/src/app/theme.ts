// Control UI module implements theme behavior.
import { inferControlUiPublicAssetPath } from "./public-assets.ts";
export type ThemeName =
  | "claw"
  | "knot"
  | "dash"
  | "absolutely"
  | "tide"
  | "beacon"
  | "phosphor"
  | "crt"
  | "manuscript"
  | "rose"
  | "miami"
  | "bench"
  | "bench-garden"
  | "bench-forge"
  | "bench-aurelius"
  | "custom";
export type ThemeMode = "system" | "light" | "dark";
export type ResolvedTheme =
  | "dark"
  | "light"
  | "openknot"
  | "openknot-light"
  | "dash"
  | "dash-light"
  | "absolutely"
  | "absolutely-light"
  | "tide"
  | "tide-light"
  | "beacon"
  | "beacon-light"
  | "phosphor"
  | "phosphor-light"
  | "crt"
  | "crt-light"
  | "manuscript"
  | "manuscript-light"
  | "rose"
  | "rose-light"
  | "miami"
  | "miami-light"
  | "bench"
  | "bench-light"
  | "bench-garden"
  | "bench-garden-light"
  | "bench-forge"
  | "bench-forge-light"
  | "bench-aurelius"
  | "bench-aurelius-light"
  | "custom"
  | "custom-light";

// Bench fork families. Appended after upstream's eleven everywhere (theme.ts,
// index.html boot map, wire enum, appearance cards, locales, typography) so
// upstream merges stay insert-only; `bench` is the fork default.
const BENCH_THEME_FAMILIES = [
  "bench",
  "bench-garden",
  "bench-forge",
  "bench-aurelius",
] as const satisfies readonly ThemeName[];
export type BenchThemeFamily = (typeof BENCH_THEME_FAMILIES)[number];

export function isBenchThemeFamily(theme: ThemeName): theme is BenchThemeFamily {
  return BENCH_THEME_FAMILIES.some((family) => family === theme);
}

const VALID_THEME_NAMES = new Set<string>([
  "claw",
  "knot",
  "dash",
  "absolutely",
  "tide",
  "beacon",
  "phosphor",
  "crt",
  "manuscript",
  "rose",
  "miami",
  ...BENCH_THEME_FAMILIES,
  "custom",
]);

const VALID_THEME_MODES = new Set<string>(["system", "light", "dark"]);

function isThemeName(value: string): value is ThemeName {
  return VALID_THEME_NAMES.has(value);
}

function isThemeMode(value: string): value is ThemeMode {
  return VALID_THEME_MODES.has(value);
}

function prefersLightScheme(): boolean {
  if (typeof globalThis.matchMedia !== "function") {
    return false;
  }
  return globalThis.matchMedia("(prefers-color-scheme: light)").matches;
}

export function parseThemeSelection(
  themeRaw: unknown,
  modeRaw: unknown,
): { theme: ThemeName; mode: ThemeMode } {
  const theme = typeof themeRaw === "string" ? themeRaw : "";
  const mode = typeof modeRaw === "string" ? modeRaw : "";

  // Bench build: the brand theme is the default for fresh profiles.
  const normalizedTheme = isThemeName(theme) ? theme : "bench";
  const normalizedMode = isThemeMode(mode) ? mode : "system";

  return { theme: normalizedTheme, mode: normalizedMode };
}

function resolveMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return prefersLightScheme() ? "light" : "dark";
  }
  return mode;
}

export function resolveTheme(theme: ThemeName, mode: ThemeMode): ResolvedTheme {
  const resolvedMode = resolveMode(mode);
  if (theme === "claw") {
    return resolvedMode === "light" ? "light" : "dark";
  }
  const family = theme === "knot" ? "openknot" : theme;
  return resolvedMode === "light" ? `${family}-light` : family;
}

/** Publish theme colors only after their stylesheet is available. */
export function syncThemePaletteStylesheet(theme: ThemeName, ready: () => void): void {
  if (typeof document === "undefined" || theme === "claw" || theme === "custom") {
    ready();
    return;
  }
  // Retain the six built-in families once visited. Their exclusive selectors
  // leave the previous theme intact during loading and make repeat switches synchronous.
  const id = `openclaw-theme-palette-${theme}`;
  const existing = document.getElementById(id);
  if (existing instanceof HTMLLinkElement && existing.sheet) {
    ready();
    return;
  }
  const link = existing instanceof HTMLLinkElement ? existing : document.createElement("link");
  const finish = (event: Event) => {
    link.removeEventListener("load", finish);
    link.removeEventListener("error", finish);
    if (event.type === "error") {
      // Failed assets must not strand startup; normal CSS defaults stay readable.
      // Remove the failed link so a later selection can retry rather than wait forever.
      console.error(`Theme palette failed to load; reload to retry: ${link.href}`);
      link.remove();
    }
    ready();
  };
  link.addEventListener("load", finish);
  link.addEventListener("error", finish);
  if (!existing) {
    link.id = id;
    link.rel = "stylesheet";
    link.href = inferControlUiPublicAssetPath(`themes/${theme}.css`);
    document.head.append(link);
  }
}
