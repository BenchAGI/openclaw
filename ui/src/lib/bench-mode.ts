// Vault ↔ App mode switch plumbing (UI-BRAND-CONTRACT §5.8, wiring agreed
// with the Vault seat 2026-09-06). The Control UI is always the Vault side;
// the App side is the BenchAGI web app.

export type BenchMode = "vault" | "app";

const BENCH_APP_URL = "https://benchagi.com/app";

/** App side, carrying the current agent so the destination pins it. */
export function benchAppHref(agentId: string | null | undefined): string {
  const url = new URL(BENCH_APP_URL);
  const id = agentId?.trim();
  if (id) {
    url.searchParams.set("agent", id);
  }
  url.searchParams.set("from", "vault");
  return url.toString();
}

/**
 * Vault side. The readiness witness requires the root document at `/` with no
 * query or fragment, so the Vault href is the bare origin root.
 */
export function benchVaultHref(location: Pick<Location, "origin"> = globalThis.location): string {
  return `${location.origin}/`;
}
