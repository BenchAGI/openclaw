// Vault ↔ App mode switch plumbing (UI-BRAND-CONTRACT §5.8, wiring agreed
// with the Vault seat 2026-09-06). The Control UI is always the Vault side;
// the App side is the BenchAGI web app.

export type BenchMode = "vault" | "app";

export const BENCH_APP_URL = "https://benchagi.com/app";

/**
 * The Vault stamps `data-bench-host="aurelius-vault"` on <html> from document
 * start (the only signal the child webview receives: no IPC, no query, no
 * bootstrap injection). Absent in a plain browser.
 */
export function isBenchVaultHost(
  root: HTMLElement | null = globalThis.document?.documentElement ?? null,
): boolean {
  return root?.dataset.benchHost === "aurelius-vault";
}

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
