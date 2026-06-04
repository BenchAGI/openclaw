import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchSyncCursorRow, BenchSyncCursorStore } from "./cursor.js";
import {
  CURSOR_STATE_MAX_ENTRIES,
  CURSOR_STATE_NAMESPACE,
  MAX_APPLIED_DIRECTIVE_IDS,
  boundAppliedRing,
  defaultCursorState,
  hasAppliedDirective,
  loadCursor,
  recordAppliedDirective,
  saveCursor,
} from "./cursor.js";

let stateDir: string;
let env: NodeJS.ProcessEnv;

function createStore(): BenchSyncCursorStore {
  return createPluginStateKeyedStoreForTests<BenchSyncCursorRow>("bench-sync", {
    namespace: CURSOR_STATE_NAMESPACE,
    maxEntries: CURSOR_STATE_MAX_ENTRIES,
    env,
  });
}

beforeEach(async () => {
  resetPluginStateStoreForTests();
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-sync-cursor-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

afterEach(async () => {
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("cursor load defaults", () => {
  it("returns a fresh default when plugin state is empty", async () => {
    const state = await loadCursor(createStore());
    expect(state).toEqual(defaultCursorState());
  });

  it("stores cursor data in the shared SQLite plugin-state database", async () => {
    const store = createStore();
    await saveCursor(store, defaultCursorState());

    await expect(
      fs.access(path.join(stateDir, "state", "openclaw.sqlite")),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(stateDir, "bench-sync"))).rejects.toThrow();
  });
});

describe("cursor save + load round trip", () => {
  it("persists and reloads a populated cursor", async () => {
    const store = createStore();
    const state = {
      cards: { "card-1": { hash: "abc", seq: 3 }, "card-2": { hash: "def", seq: 7 } },
      directiveCursor: "cursor-42",
      appliedDirectiveIds: ["d1", "d2"],
    };

    await saveCursor(store, state);

    await expect(loadCursor(store)).resolves.toEqual(state);
  });

  it("stores card cursors as separate rows and prunes stale rows", async () => {
    const store = createStore();
    await saveCursor(store, {
      cards: { "card-1": { hash: "abc", seq: 3 }, "card-2": { hash: "def", seq: 7 } },
      directiveCursor: "cursor-42",
      appliedDirectiveIds: ["d1"],
    });

    await saveCursor(store, {
      cards: { "card-2": { hash: "def", seq: 8 } },
      directiveCursor: "cursor-43",
      appliedDirectiveIds: ["d2"],
    });

    expect(await loadCursor(store)).toEqual({
      cards: { "card-2": { hash: "def", seq: 8 } },
      directiveCursor: "cursor-43",
      appliedDirectiveIds: ["d2"],
    });
    const cardRows = (await store.entries()).filter((entry) => entry.value.kind === "card");
    expect(cardRows).toHaveLength(1);
  });

  it("hashes card ids before using them as plugin-state keys", async () => {
    const store = createStore();
    const longCardId = `agent/card/${"x".repeat(700)}`;

    await saveCursor(store, {
      ...defaultCursorState(),
      cards: { [longCardId]: { hash: "abc", seq: 1 } },
    });

    const cardKey = (await store.entries()).find((entry) => entry.value.kind === "card")?.key;
    expect(cardKey).toBeDefined();
    expect(cardKey).not.toContain(longCardId);
    expect(Buffer.byteLength(cardKey ?? "", "utf8")).toBeLessThanOrEqual(512);
  });
});

describe("cursor corrupt recovery", () => {
  it("clears an invalid meta row and starts with default meta", async () => {
    const store = createStore();
    await store.register("meta", {
      kind: "meta",
      directiveCursor: 123,
      appliedDirectiveIds: [],
    } as unknown as BenchSyncCursorRow);

    const warnings: string[] = [];
    const state = await loadCursor(store, { warn: (m) => warnings.push(m) });

    expect(state).toEqual(defaultCursorState());
    expect(warnings.some((w) => /invalid cursor plugin-state row/i.test(w))).toBe(true);
    expect((await store.entries()).map((entry) => entry.key)).not.toContain("meta");
  });

  it("keeps valid rows while clearing invalid card rows", async () => {
    const store = createStore();
    await saveCursor(store, {
      ...defaultCursorState(),
      cards: { "good-card": { hash: "ok", seq: 2 } },
    });
    await store.register("card:bad", {
      kind: "card",
      cardId: "bad-card",
      cursor: { hash: 1 },
    } as unknown as BenchSyncCursorRow);

    const state = await loadCursor(store);

    expect(state.cards).toEqual({ "good-card": { hash: "ok", seq: 2 } });
    expect((await store.entries()).map((entry) => entry.key)).not.toContain("card:bad");
  });
});

describe("applied-directive ring", () => {
  it("dedupes and appends applied ids", () => {
    let state = defaultCursorState();
    state = recordAppliedDirective(state, "a");
    state = recordAppliedDirective(state, "b");
    state = recordAppliedDirective(state, "a");
    expect(state.appliedDirectiveIds).toEqual(["b", "a"]);
    expect(hasAppliedDirective(state, "a")).toBe(true);
    expect(hasAppliedDirective(state, "z")).toBe(false);
  });

  it("bounds the ring to MAX_APPLIED_DIRECTIVE_IDS", () => {
    let state = defaultCursorState();
    for (let i = 0; i < MAX_APPLIED_DIRECTIVE_IDS + 50; i += 1) {
      state = recordAppliedDirective(state, `d${i}`);
    }
    expect(state.appliedDirectiveIds).toHaveLength(MAX_APPLIED_DIRECTIVE_IDS);
    // Oldest entries dropped, newest retained.
    expect(state.appliedDirectiveIds.at(-1)).toBe(`d${MAX_APPLIED_DIRECTIVE_IDS + 49}`);
    expect(hasAppliedDirective(state, "d0")).toBe(false);
  });

  it("bounds the ring on save even if state exceeds the cap", async () => {
    const store = createStore();
    const oversized = {
      ...defaultCursorState(),
      appliedDirectiveIds: Array.from(
        { length: MAX_APPLIED_DIRECTIVE_IDS + 10 },
        (_, i) => `d${i}`,
      ),
    };

    await saveCursor(store, oversized);

    const loaded = await loadCursor(store);
    expect(loaded.appliedDirectiveIds).toHaveLength(MAX_APPLIED_DIRECTIVE_IDS);
  });

  it("boundAppliedRing keeps the most recent entries", () => {
    expect(boundAppliedRing(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});
