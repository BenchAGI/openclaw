// Memory Wiki tests cover source sync state plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertMemoryWikiSourceSyncStateCapacity,
  configureMemoryWikiSourceSyncStateStore,
  createMemoryWikiSourceSyncStateStore,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  pruneImportedSourceEntries,
  readLegacyMemoryWikiSourceSyncState,
  readMemoryWikiSourceSyncState,
  resolveMemoryWikiSourceSyncStatePath,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";
import type { MemoryWikiImportedSourceState } from "./source-sync-state.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-source-sync-"));
  tempDirs.push(dir);
  return dir;
}

function openStore(env: NodeJS.ProcessEnv) {
  return createMemoryWikiSourceSyncStateStore(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>("memory-wiki", { ...options, env }),
  );
}

describe("memory wiki source sync state", () => {
  beforeEach(() => {
    resetPluginStateStoreForTests();
    configureMemoryWikiSourceSyncStateStore(undefined);
  });

  afterEach(async () => {
    configureMemoryWikiSourceSyncStateStore(undefined);
    resetPluginStateStoreForTests();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("never prunes a bridge page whose source artifact lives under a sibling user home", async () => {
    const vaultRoot = await makeTempDir();
    const sourcesDir = path.join(vaultRoot, "sources");
    await fs.mkdir(sourcesDir, { recursive: true });
    const localPage = path.join(sourcesDir, "local.md");
    const externalLocalPage = path.join(sourcesDir, "external-local.md");
    const foreignPage = path.join(sourcesDir, "foreign.md");
    await fs.writeFile(localPage, "# local\n");
    await fs.writeFile(externalLocalPage, "# external local\n");
    await fs.writeFile(foreignPage, "# foreign\n");

    const homeDir = "/Users/coryshelton";
    const state: MemoryWikiImportedSourceState = {
      version: 1,
      entries: {
        local: {
          group: "bridge",
          pagePath: "sources/local.md",
          sourcePath: "/Users/coryshelton/.claude/projects/x/memory/a.md",
          sourceUpdatedAtMs: 1,
          sourceSize: 1,
          renderFingerprint: "a",
        },
        externalLocal: {
          group: "bridge",
          pagePath: "sources/external-local.md",
          sourcePath: "/tmp/openclaw-workspace/MEMORY.md",
          sourceUpdatedAtMs: 3,
          sourceSize: 3,
          renderFingerprint: "c",
        },
        foreign: {
          group: "bridge",
          pagePath: "sources/foreign.md",
          sourcePath: "/Users/jory/.claude/projects/y/memory/b.md",
          sourceUpdatedAtMs: 2,
          sourceSize: 2,
          renderFingerprint: "b",
        },
      },
    };

    // All entries are orphans (empty activeKeys). Local paths, including temp
    // or mounted workspaces outside home, still prune. Sibling home paths survive
    // because they are treated as cross-operator federation state.
    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set<string>(),
      state,
      localHomeDir: homeDir,
    });

    expect(removed).toBe(2);
    await expect(fs.stat(localPage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(externalLocalPage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(foreignPage)).resolves.toBeTruthy();
    expect(state.entries.local).toBeUndefined();
    expect(state.entries.externalLocal).toBeUndefined();
    expect(state.entries.foreign).toBeDefined();
  });

  it("does not treat every absolute source path as foreign when the local home is /root", async () => {
    const vaultRoot = await makeTempDir();
    const sourcesDir = path.join(vaultRoot, "sources");
    await fs.mkdir(sourcesDir, { recursive: true });
    const localPage = path.join(sourcesDir, "root-temp.md");
    const foreignPage = path.join(sourcesDir, "root-foreign.md");
    await fs.writeFile(localPage, "# local temp\n");
    await fs.writeFile(foreignPage, "# foreign home\n");
    const state: MemoryWikiImportedSourceState = {
      version: 1,
      entries: {
        rootTemp: {
          group: "bridge",
          pagePath: "sources/root-temp.md",
          sourcePath: "/tmp/openclaw-workspace/MEMORY.md",
          sourceUpdatedAtMs: 1,
          sourceSize: 1,
          renderFingerprint: "root-temp",
        },
        rootForeign: {
          group: "bridge",
          pagePath: "sources/root-foreign.md",
          sourcePath: "/home/alice/.claude/projects/memory/MEMORY.md",
          sourceUpdatedAtMs: 2,
          sourceSize: 2,
          renderFingerprint: "root-foreign",
        },
      },
    };

    const removed = await pruneImportedSourceEntries({
      vaultRoot,
      group: "bridge",
      activeKeys: new Set<string>(),
      state,
      localHomeDir: "/root",
    });

    expect(removed).toBe(1);
    await expect(fs.stat(localPage)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(foreignPage)).resolves.toBeTruthy();
    expect(state.entries.rootTemp).toBeUndefined();
    expect(state.entries.rootForeign).toBeDefined();
  });

  it("persists source sync entries in plugin state", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });

    await writeMemoryWikiSourceSyncState(
      vaultRoot,
      {
        version: 1,
        entries: {
          alpha: {
            group: "bridge",
            pagePath: "sources/alpha.md",
            sourcePath: "/tmp/source.md",
            sourceUpdatedAtMs: 123,
            sourceSize: 456,
            renderFingerprint: "fingerprint",
          },
        },
      },
      store,
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot, store)).resolves.toEqual({
      version: 1,
      entries: {
        alpha: {
          group: "bridge",
          pagePath: "sources/alpha.md",
          sourcePath: "/tmp/source.md",
          sourceUpdatedAtMs: 123,
          sourceSize: 456,
          renderFingerprint: "fingerprint",
        },
      },
    });
    await expect(fs.stat(resolveMemoryWikiSourceSyncStatePath(vaultRoot))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps legacy file reads separate for doctor migration", async () => {
    const vaultRoot = await makeTempDir();
    const legacyPath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
    await fs.mkdir(path.dirname(legacyPath), { recursive: true });
    await fs.writeFile(
      legacyPath,
      `${JSON.stringify({
        version: 1,
        entries: {
          beta: {
            group: "unsafe-local",
            pagePath: "sources/beta.md",
            sourcePath: "/tmp/beta.md",
            sourceUpdatedAtMs: 10,
            sourceSize: 20,
            renderFingerprint: "beta",
          },
        },
      })}\n`,
    );

    await expect(readMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {},
    });
    await expect(readLegacyMemoryWikiSourceSyncState(vaultRoot)).resolves.toEqual({
      version: 1,
      entries: {
        beta: {
          group: "unsafe-local",
          pagePath: "sources/beta.md",
          sourcePath: "/tmp/beta.md",
          sourceUpdatedAtMs: 10,
          sourceSize: 20,
          renderFingerprint: "beta",
        },
      },
    });
  });

  it("rejects writes beyond the source-sync state row cap", async () => {
    const stateDir = await makeTempDir();
    const vaultRoot = path.join(stateDir, "vault");
    const store = openStore({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    const entries = Object.fromEntries(
      Array.from({ length: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES + 1 }, (_, index) => [
        `source-${index}`,
        {
          group: "bridge" as const,
          pagePath: `sources/source-${index}.md`,
          sourcePath: `/tmp/source-${index}.md`,
          sourceUpdatedAtMs: index,
          sourceSize: index,
          renderFingerprint: `fingerprint-${index}`,
        },
      ]),
    );

    await expect(
      writeMemoryWikiSourceSyncState(vaultRoot, { version: 1, entries }, store),
    ).rejects.toThrow("Memory Wiki source sync state exceeds SQLite entry limit");
  });

  it("rejects projected imports that would exceed the source-sync row cap", () => {
    expect(() =>
      assertMemoryWikiSourceSyncStateCapacity({
        state: {
          version: 1,
          entries: {
            retained: {
              group: "unsafe-local",
              pagePath: "sources/retained.md",
              sourcePath: "/tmp/retained.md",
              sourceUpdatedAtMs: 1,
              sourceSize: 1,
              renderFingerprint: "retained",
            },
          },
        },
        group: "bridge",
        incomingCount: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      }),
    ).toThrow("Memory Wiki source sync state exceeds SQLite entry limit");
  });
});
