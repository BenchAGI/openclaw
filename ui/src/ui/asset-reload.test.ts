/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installAssetReloadRecovery,
  isStaleAssetImportError,
  reloadForStaleAssetImport,
  setAssetReloadHandlerForTest,
} from "./asset-reload.ts";

describe("asset reload recovery", () => {
  afterEach(() => {
    sessionStorage.clear();
    setAssetReloadHandlerForTest();
    vi.restoreAllMocks();
  });

  it("detects stale dynamic asset import failures", () => {
    expect(
      isStaleAssetImportError(
        new Error(
          "Failed to fetch dynamically imported module: http://localhost:18789/assets/nodes-D6k2iJfZ.js",
        ),
      ),
    ).toBe(true);
    expect(isStaleAssetImportError(new Error("ordinary failure"))).toBe(false);
  });

  it("reloads once and throttles repeated stale asset failures", () => {
    const reload = vi.fn();
    setAssetReloadHandlerForTest(reload);

    expect(reloadForStaleAssetImport(new Error("/assets/nodes-D6k2iJfZ.js"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadForStaleAssetImport(new Error("/assets/nodes-D6k2iJfZ.js"))).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("handles vite preload errors", () => {
    const reload = vi.fn();
    setAssetReloadHandlerForTest(reload);
    installAssetReloadRecovery();
    const event = new Event("vite:preloadError", { cancelable: true }) as Event & {
      payload?: unknown;
    };
    event.payload = new Error("/assets/app-deadbeef.js");

    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
