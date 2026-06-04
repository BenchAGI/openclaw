import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import type { BenchSyncCursorStore } from "./cursor.js";
import { createBenchSyncLoop } from "./loop.js";

function makeLogger(): PluginLogger & { debugLines: string[]; warnLines: string[] } {
  const debugLines: string[] = [];
  const warnLines: string[] = [];
  return {
    debugLines,
    warnLines,
    debug: (m: string) => debugLines.push(m),
    info: () => {},
    warn: (m: string) => warnLines.push(m),
    error: () => {},
  };
}

function makeCursorStore(): BenchSyncCursorStore {
  return {
    delete: vi.fn(async () => true),
    entries: vi.fn(async () => []),
    register: vi.fn(async () => {}),
  };
}

function startOptions(logger: PluginLogger) {
  return {
    config: {} as OpenClawConfig,
    stateDir: "/tmp/does-not-matter",
    cursorStore: makeCursorStore(),
    logger,
    pollIntervalMs: 15_000,
  };
}

describe("createBenchSyncLoop", () => {
  it("emits a debug heartbeat each tick", async () => {
    const logger = makeLogger();
    const loop = createBenchSyncLoop();
    const abort = new AbortController();

    await loop.runTickOnce(startOptions(logger), abort);

    expect(logger.debugLines.some((l) => l.includes("heartbeat tick #1"))).toBe(true);
  });

  it("runs registered tick handlers in order with a shared context", async () => {
    const logger = makeLogger();
    const loop = createBenchSyncLoop();
    const calls: string[] = [];
    loop.addTickHandler({ name: "a", run: () => void calls.push("a") });
    loop.addTickHandler({ name: "b", run: () => void calls.push("b") });
    const abort = new AbortController();

    await loop.runTickOnce(startOptions(logger), abort);

    expect(calls).toEqual(["a", "b"]);
  });

  it("passes the cursor store through the shared tick context", async () => {
    const logger = makeLogger();
    const loop = createBenchSyncLoop();
    const options = startOptions(logger);
    const seenStores: BenchSyncCursorStore[] = [];
    loop.addTickHandler({ name: "store", run: (ctx) => void seenStores.push(ctx.cursorStore) });
    const abort = new AbortController();

    await loop.runTickOnce(options, abort);

    expect(seenStores).toEqual([options.cursorStore]);
  });

  it("isolates a failing handler so others still run and the loop survives", async () => {
    const logger = makeLogger();
    const loop = createBenchSyncLoop();
    const calls: string[] = [];
    loop.addTickHandler({
      name: "boom",
      run: () => {
        throw new Error("handler exploded");
      },
    });
    loop.addTickHandler({ name: "after", run: () => void calls.push("after") });
    const abort = new AbortController();

    await expect(loop.runTickOnce(startOptions(logger), abort)).resolves.toBeUndefined();
    expect(calls).toEqual(["after"]);
    expect(logger.warnLines.some((l) => l.includes("boom") && l.includes("failed"))).toBe(true);
  });

  it("skips work when the abort signal is already aborted", async () => {
    const logger = makeLogger();
    const loop = createBenchSyncLoop();
    const handler = vi.fn();
    loop.addTickHandler({ name: "x", run: handler });
    const abort = new AbortController();
    abort.abort();

    await loop.runTickOnce(startOptions(logger), abort);
    expect(handler).not.toHaveBeenCalled();
  });

  it("start() then stop() flips isRunning", () => {
    const logger = makeLogger();
    const loop = createBenchSyncLoop();
    expect(loop.isRunning()).toBe(false);
    loop.start(startOptions(logger));
    expect(loop.isRunning()).toBe(true);
    loop.stop();
    expect(loop.isRunning()).toBe(false);
  });
});
