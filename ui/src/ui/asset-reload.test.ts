import { afterEach, describe, expect, it, vi } from "vitest";
import { createStorageMock } from "../test-helpers/storage.ts";
import {
  installAssetReloadRecovery,
  isStaleAssetImportError,
  shouldReloadForStaleAsset,
} from "./asset-reload.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("asset reload recovery", () => {
  it("detects stale hashed asset import failures", () => {
    expect(
      isStaleAssetImportError(
        new TypeError("Failed to fetch dynamically imported module: http://localhost:18789/assets/nodes-D6k2iJfZ.js"),
      ),
    ).toBe(true);
    expect(isStaleAssetImportError(new Error("ordinary gateway failure"))).toBe(false);
  });

  it("throttles reloads to prevent a refresh loop", () => {
    const storage = createStorageMock();
    expect(shouldReloadForStaleAsset(100, storage)).toBe(true);
    expect(shouldReloadForStaleAsset(200, storage)).toBe(false);
    expect(shouldReloadForStaleAsset(31_000, storage)).toBe(true);
  });

  it("reloads on Vite preload errors", () => {
    const listeners = new Map<string, EventListenerOrEventListenerObject>();
    const reload = vi.fn();
    const win = {
      sessionStorage: createStorageMock(),
      location: { reload },
      addEventListener: vi.fn((name: string, handler: EventListenerOrEventListenerObject) => {
        listeners.set(name, handler);
      }),
    } as unknown as Window;

    installAssetReloadRecovery(win);
    const handler = listeners.get("vite:preloadError") as EventListener;
    const event = {
      payload: new Error("Failed to fetch dynamically imported module: /assets/nodes-D6k2iJfZ.js"),
      preventDefault: vi.fn(),
    } as unknown as Event;
    handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
