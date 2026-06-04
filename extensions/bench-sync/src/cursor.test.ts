import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MAX_APPLIED_DIRECTIVE_IDS,
  boundAppliedRing,
  cursorFilePath,
  defaultCursorState,
  hasAppliedDirective,
  loadCursor,
  recordAppliedDirective,
  saveCursor,
} from "./cursor.js";

let stateDir: string;

beforeEach(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "bench-sync-cursor-"));
});

afterEach(async () => {
  await fs.rm(stateDir, { recursive: true, force: true });
});

describe("cursor load defaults", () => {
  it("returns a fresh default when the file is missing", async () => {
    const state = await loadCursor(stateDir);
    expect(state).toEqual(defaultCursorState());
  });

  it("places the cursor under <stateDir>/bench-sync/cursor.json", () => {
    expect(cursorFilePath(stateDir)).toBe(path.join(stateDir, "bench-sync", "cursor.json"));
  });
});

describe("cursor save + load round trip", () => {
  it("persists and reloads a populated cursor", async () => {
    const state = {
      cards: { "card-1": { hash: "abc", seq: 3 }, "card-2": { hash: "def", seq: 7 } },
      directiveCursor: "cursor-42",
      appliedDirectiveIds: ["d1", "d2"],
    };
    await saveCursor(stateDir, state);
    const loaded = await loadCursor(stateDir);
    expect(loaded).toEqual(state);
  });

  it("writes the file with 0600 permissions (atomic helper)", async () => {
    await saveCursor(stateDir, defaultCursorState());
    const stat = await fs.stat(cursorFilePath(stateDir));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("leaves no leftover temp files in the cursor directory", async () => {
    await saveCursor(stateDir, defaultCursorState());
    const entries = await fs.readdir(path.join(stateDir, "bench-sync"));
    expect(entries).toEqual(["cursor.json"]);
  });
});

describe("cursor corrupt recovery", () => {
  it("renames invalid JSON aside to .bak and starts fresh", async () => {
    const filePath = cursorFilePath(stateDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, "{ not valid json", "utf8");

    const warnings: string[] = [];
    const state = await loadCursor(stateDir, { warn: (m) => warnings.push(m) });

    expect(state).toEqual(defaultCursorState());
    expect(warnings.some((w) => /corrupt cursor/i.test(w))).toBe(true);
    await expect(fs.readFile(`${filePath}.bak`, "utf8")).resolves.toContain("not valid json");
  });

  it("renames a structurally invalid cursor aside and starts fresh", async () => {
    const filePath = cursorFilePath(stateDir);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify({ cards: { x: { hash: 1 } } }), "utf8");

    const state = await loadCursor(stateDir);
    expect(state).toEqual(defaultCursorState());
    await expect(fs.stat(`${filePath}.bak`)).resolves.toBeDefined();
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
    const oversized = {
      ...defaultCursorState(),
      appliedDirectiveIds: Array.from(
        { length: MAX_APPLIED_DIRECTIVE_IDS + 10 },
        (_, i) => `d${i}`,
      ),
    };
    await saveCursor(stateDir, oversized);
    const loaded = await loadCursor(stateDir);
    expect(loaded.appliedDirectiveIds).toHaveLength(MAX_APPLIED_DIRECTIVE_IDS);
  });

  it("boundAppliedRing keeps the most recent entries", () => {
    expect(boundAppliedRing(["a", "b", "c"])).toEqual(["a", "b", "c"]);
  });
});
