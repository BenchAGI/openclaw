const LAST_RELOAD_KEY = "openclaw.control.asset-reload.last";
const RELOAD_COOLDOWN_MS = 30_000;

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "object" && value && "message" in value) {
    return String((value as { message?: unknown }).message ?? "");
  }
  return String(value ?? "");
}

export function isStaleAssetImportError(value: unknown): boolean {
  const message = errorMessage(value);
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    message.includes("Importing a module script failed") ||
    message.includes("error loading dynamically imported module") ||
    /\/assets\/[^/\s]+-[A-Za-z0-9_-]+\.(?:js|css)/.test(message)
  );
}

export function shouldReloadForStaleAsset(now = Date.now(), storage = globalThis.sessionStorage) {
  const raw = storage?.getItem(LAST_RELOAD_KEY);
  const previous = raw ? Number.parseInt(raw, 10) : 0;
  if (Number.isFinite(previous) && previous > 0 && now - previous < RELOAD_COOLDOWN_MS) {
    return false;
  }
  storage?.setItem(LAST_RELOAD_KEY, String(now));
  return true;
}

export function installAssetReloadRecovery(win: Window = window) {
  const maybeReload = (reason: unknown) => {
    if (!isStaleAssetImportError(reason) || !shouldReloadForStaleAsset(Date.now(), win.sessionStorage)) {
      return false;
    }
    win.location.reload();
    return true;
  };

  win.addEventListener("vite:preloadError", (event) => {
    if (maybeReload((event as Event & { payload?: unknown }).payload)) {
      event.preventDefault();
    }
  });

  win.addEventListener("unhandledrejection", (event) => {
    if (maybeReload(event.reason)) {
      event.preventDefault();
    }
  });
}
