import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BenchSyncCursorRow, BenchSyncCursorState, BenchSyncCursorStore } from "./cursor.js";
import {
  CURSOR_STATE_MAX_ENTRIES,
  CURSOR_STATE_NAMESPACE,
  MAX_APPLIED_DIRECTIVE_IDS,
  boundAppliedRing,
  defaultCursorState,
  getAppliedDirectiveAck,
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

  it("reserves row budget for card/proposal cursors plus directive ack rows", () => {
    expect(CURSOR_STATE_MAX_ENTRIES).toBeGreaterThanOrEqual(5_000 + MAX_APPLIED_DIRECTIVE_IDS + 1);
  });
});

describe("cursor save + load round trip", () => {
  it("persists and reloads a populated cursor", async () => {
    const store = createStore();
    const state: BenchSyncCursorState = {
      cards: { "card-1": { hash: "abc", seq: 3 }, "card-2": { hash: "def", seq: 7 } },
      proposals: { "prop-1": { hash: "p1" } },
      directiveCursor: "cursor-42",
      appliedDirectiveIds: ["d1", "d2"],
      directiveAcks: { d2: { status: "applied", result: { proposalId: "prop-1" } } },
    };

    await saveCursor(store, state);

    await expect(loadCursor(store)).resolves.toEqual(state);
  });

  it("stores card cursors as separate rows and prunes stale rows", async () => {
    const store = createStore();
    await saveCursor(store, {
      ...defaultCursorState(),
      cards: { "card-1": { hash: "abc", seq: 3 }, "card-2": { hash: "def", seq: 7 } },
      directiveCursor: "cursor-42",
      appliedDirectiveIds: ["d1"],
      directiveAcks: { d1: { status: "failed", error: { code: "x", message: "failed" } } },
    });

    await saveCursor(store, {
      ...defaultCursorState(),
      cards: { "card-2": { hash: "def", seq: 8 } },
      directiveCursor: "cursor-43",
      appliedDirectiveIds: ["d2"],
      directiveAcks: { d2: { status: "skipped", reason: "already applied" } },
    });

    expect(await loadCursor(store)).toEqual({
      ...defaultCursorState(),
      cards: { "card-2": { hash: "def", seq: 8 } },
      directiveCursor: "cursor-43",
      appliedDirectiveIds: ["d2"],
      directiveAcks: { d2: { status: "skipped", reason: "already applied" } },
    });
    const cardRows = (await store.entries()).filter((entry) => entry.value.kind === "card");
    expect(cardRows).toHaveLength(1);
  });

  it("stores proposal cursors as separate rows and prunes stale rows", async () => {
    const store = createStore();
    await saveCursor(store, {
      ...defaultCursorState(),
      proposals: { "prop-1": { hash: "abc" }, "prop-2": { hash: "def" } },
    });

    await saveCursor(store, {
      ...defaultCursorState(),
      proposals: { "prop-2": { hash: "next" } },
    });

    expect(await loadCursor(store)).toEqual({
      ...defaultCursorState(),
      proposals: { "prop-2": { hash: "next" } },
    });
    const proposalRows = (await store.entries()).filter((entry) => entry.value.kind === "proposal");
    expect(proposalRows).toHaveLength(1);
  });

  it("stores directive acks as separate rows and prunes stale rows", async () => {
    const store = createStore();
    await saveCursor(store, {
      ...defaultCursorState(),
      appliedDirectiveIds: ["dir-1", "dir-2"],
      directiveAcks: {
        "dir-1": { status: "applied", result: { proposalId: "prop-1" } },
        "dir-2": { status: "failed", error: { code: "scan", message: "blocked" } },
      },
    });

    let entries = await store.entries();
    expect(entries.filter((entry) => entry.value.kind === "directiveAck")).toHaveLength(2);
    expect(entries.find((entry) => entry.value.kind === "meta")?.value).not.toHaveProperty(
      "directiveAcks",
    );

    await saveCursor(store, {
      ...defaultCursorState(),
      appliedDirectiveIds: ["dir-2"],
      directiveAcks: {
        "dir-2": { status: "skipped", reason: "already applied" },
      },
    });

    expect(await loadCursor(store)).toEqual({
      ...defaultCursorState(),
      appliedDirectiveIds: ["dir-2"],
      directiveAcks: { "dir-2": { status: "skipped", reason: "already applied" } },
    });
    entries = await store.entries();
    expect(entries.filter((entry) => entry.value.kind === "directiveAck")).toHaveLength(1);
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

  it("keeps valid rows while clearing invalid proposal rows", async () => {
    const store = createStore();
    await saveCursor(store, {
      ...defaultCursorState(),
      proposals: { "good-prop": { hash: "ok" } },
    });
    await store.register("proposal:bad", {
      kind: "proposal",
      proposalId: "bad-prop",
      cursor: { hash: 1 },
    } as unknown as BenchSyncCursorRow);

    const state = await loadCursor(store);

    expect(state.proposals).toEqual({ "good-prop": { hash: "ok" } });
    expect((await store.entries()).map((entry) => entry.key)).not.toContain("proposal:bad");
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

  it("checks cached directive acks by own property for opaque ids", () => {
    const ringOnly = {
      ...defaultCursorState(),
      appliedDirectiveIds: ["toString"],
    };
    expect(getAppliedDirectiveAck(ringOnly, "toString")).toBeNull();

    const state = recordAppliedDirective(defaultCursorState(), "__proto__", {
      status: "skipped",
      reason: "already applied",
    });
    expect(getAppliedDirectiveAck(state, "__proto__")).toEqual({
      status: "skipped",
      reason: "already applied",
    });
    expect(Object.getPrototypeOf(state.directiveAcks)).toBe(Object.prototype);
  });

  it("bounds the ring to MAX_APPLIED_DIRECTIVE_IDS", () => {
    let state = defaultCursorState();
    for (let i = 0; i < MAX_APPLIED_DIRECTIVE_IDS + 50; i += 1) {
      state = recordAppliedDirective(state, `d${i}`, {
        status: "applied",
        result: { proposalId: `p${i}` },
      });
    }
    expect(state.appliedDirectiveIds).toHaveLength(MAX_APPLIED_DIRECTIVE_IDS);
    // Oldest entries dropped, newest retained.
    expect(state.appliedDirectiveIds.at(-1)).toBe(`d${MAX_APPLIED_DIRECTIVE_IDS + 49}`);
    expect(hasAppliedDirective(state, "d0")).toBe(false);
    expect(state.directiveAcks.d0).toBeUndefined();
    expect(state.directiveAcks[`d${MAX_APPLIED_DIRECTIVE_IDS + 49}`]).toMatchObject({
      status: "applied",
    });
  });

  it("bounds the ring on save even if state exceeds the cap", async () => {
    const store = createStore();
    const oversized = {
      ...defaultCursorState(),
      appliedDirectiveIds: Array.from(
        { length: MAX_APPLIED_DIRECTIVE_IDS + 10 },
        (_, i) => `d${i}`,
      ),
      directiveAcks: Object.fromEntries(
        Array.from({ length: MAX_APPLIED_DIRECTIVE_IDS + 10 }, (_, i) => [
          `d${i}`,
          { status: "applied", result: { proposalId: `p${i}` } },
        ]),
      ) as BenchSyncCursorState["directiveAcks"],
    };

    await saveCursor(store, oversized);

    const loaded = await loadCursor(store);
    expect(loaded.appliedDirectiveIds).toHaveLength(MAX_APPLIED_DIRECTIVE_IDS);
    expect(Object.keys(loaded.directiveAcks)).toHaveLength(MAX_APPLIED_DIRECTIVE_IDS);
  });

  it("boundAppliedRing keeps the most recent entries", () => {
    expect(boundAppliedRing(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});
