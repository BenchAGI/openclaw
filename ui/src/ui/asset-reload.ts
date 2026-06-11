// Recover from stale Vite chunk URLs after the control UI has been rebuilt.
const RELOAD_SESSION_KEY = "openclaw.control.asset-reload.last";
const RELOAD_COOLDOWN_MS = 30_000;

let reloadWindow = () => window.location.reload();

export function setAssetReloadHandlerForTest(handler?: () => void): void {
  reloadWindow = handler ?? (() => window.location.reload());
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "message" in value) {
    const message = (value as { message?: unknown }).message;
    return typeof message === "string" ? message : "";
  }
  return "";
}

export function isStaleAssetImportError(value: unknown): boolean {
  const message = errorMessage(value);
  if (!message) {
    return false;
  }
  return (
    message.includes("Failed to fetch dynamically imported module") ||
    /\/assets\/[^/\s)]+?\.(?:js|css)(?:\?|$|\s|\))/u.test(message)
  );
}

function shouldReload(now = Date.now()): boolean {
  try {
    const previous = Number.parseInt(window.sessionStorage.getItem(RELOAD_SESSION_KEY) ?? "", 10);
    if (Number.isFinite(previous) && now - previous < RELOAD_COOLDOWN_MS) {
      return false;
    }
    window.sessionStorage.setItem(RELOAD_SESSION_KEY, String(now));
  } catch {
    // If storage is unavailable, a one-shot reload is still the least surprising recovery.
  }
  return true;
}

export function reloadForStaleAssetImport(value: unknown): boolean {
  if (!isStaleAssetImportError(value)) {
    return false;
  }
  if (!shouldReload()) {
    return true;
  }
  reloadWindow();
  return true;
}

export function installAssetReloadRecovery(): void {
  window.addEventListener("vite:preloadError", (event) => {
    const payload = (event as Event & { payload?: unknown }).payload;
    if (reloadForStaleAssetImport(payload)) {
      event.preventDefault();
    }
  });
  window.addEventListener("unhandledrejection", (event) => {
    if (reloadForStaleAssetImport(event.reason)) {
      event.preventDefault();
    }
  });
}
