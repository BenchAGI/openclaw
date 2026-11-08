import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import type { PersistedWorkboardCard, WorkboardCardStore } from "../persistence-types.js";
import { workboardSqliteBackendEntrypoint } from "../sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "../sqlite-store.js";
import { WorkboardStore } from "../store.js";
import { sqliteTestAuxStores } from "./sqlite-store.js";

const workerModuleUrl = resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint);

function createPausedCardStore(delegate: WorkboardCardStore) {
  let pause:
    | {
        reached: () => void;
        waitForResume: Promise<void>;
      }
    | undefined;
  let pauseAfter:
    | {
        matches: (key: string, value: PersistedWorkboardCard | undefined) => boolean;
        reached: () => void;
        waitForResume: Promise<void>;
      }
    | undefined;
  const beforeWrite = async () => {
    const current = pause;
    if (!current) {
      return;
    }
    pause = undefined;
    current.reached();
    await current.waitForResume;
  };
  const afterWrite = async (key: string, value?: PersistedWorkboardCard) => {
    const current = pauseAfter;
    if (!current || !current.matches(key, value)) {
      return;
    }
    pauseAfter = undefined;
    current.reached();
    await current.waitForResume;
  };
  return {
    store: {
      async register(key, value) {
        await beforeWrite();
        await delegate.register(key, value);
        await afterWrite(key, value);
      },
      async registerIfAbsent(key, value) {
        await beforeWrite();
        const inserted = await delegate.registerIfAbsent(key, value);
        if (inserted) {
          await afterWrite(key, value);
        }
        return inserted;
      },
      async registerIfUpdatedAt(key, value, expectedUpdatedAt) {
        await beforeWrite();
        const updated = await delegate.registerIfUpdatedAt(key, value, expectedUpdatedAt);
        if (updated) {
          await afterWrite(key, value);
        }
        return updated;
      },
      async claimIfOwnerAvailable(key, value, expectedUpdatedAt, ownerId, now) {
        await beforeWrite();
        const result = await delegate.claimIfOwnerAvailable(
          key,
          value,
          expectedUpdatedAt,
          ownerId,
          now,
        );
        if (result === "updated") {
          await afterWrite(key, value);
        }
        return result;
      },
      async deleteIfUpdatedAt(key, expectedUpdatedAt) {
        await beforeWrite();
        const deleted = await delegate.deleteIfUpdatedAt(key, expectedUpdatedAt);
        if (deleted) {
          await afterWrite(key);
        }
        return deleted;
      },
      async lookup(key) {
        return await delegate.lookup(key);
      },
      async delete(key) {
        await beforeWrite();
        const deleted = await delegate.delete(key);
        if (deleted) {
          await afterWrite(key);
        }
        return deleted;
      },
      async entries(boardId) {
        return await delegate.entries(boardId);
      },
      listCardStatuses: (ids) => delegate.listCardStatuses(ids),
      async listBoardAggregates() {
        return await delegate.listBoardAggregates();
      },
      listStatsAggregates: (boardId) => delegate.listStatsAggregates(boardId),
      hasCards: (boardId) => delegate.hasCards(boardId),
    } satisfies WorkboardCardStore,
    pauseNextWrite() {
      const reached = createDeferred<void>();
      const resume = createDeferred<void>();
      pause = { reached: () => reached.resolve(), waitForResume: resume.promise };
      return { reached: reached.promise, resume: () => resume.resolve() };
    },
    pauseAfterMatchingWrite(
      matches: (key: string, value: PersistedWorkboardCard | undefined) => boolean,
    ) {
      const reached = createDeferred<void>();
      const resume = createDeferred<void>();
      pauseAfter = {
        matches,
        reached: () => reached.resolve(),
        waitForResume: resume.promise,
      };
      return { reached: reached.promise, resume: () => resume.resolve() };
    },
  };
}

export function createConcurrentSqliteHarness(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, "workboard.sqlite");
  const operationStores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  const hostStores = createWorkboardSqliteStores({ dbPath, workerModuleUrl });
  const paused = createPausedCardStore(operationStores.cards);
  return {
    operation: new WorkboardStore(paused.store, sqliteTestAuxStores(operationStores)),
    host: new WorkboardStore(hostStores.cards, sqliteTestAuxStores(hostStores)),
    paused,
    async [Symbol.asyncDispose]() {
      await hostStores.close();
      await operationStores.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
