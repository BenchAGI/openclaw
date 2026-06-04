// bench-sync — additive fork plugin that mirrors local Workboard cards and
// skill proposals up to the Bench cloud and applies governed directives down.
//
// The service registers a background polling loop (B1 scaffold). B2 slots the
// Workboard up-mirror in as a tick handler; B3 adds the directive pull/apply +
// proposal mirror-up handler. The loop structure itself is not changed —
// handlers are appended via addTickHandler.

import { WorkboardStore } from "../workboard/src/store.js";
import { definePluginEntry } from "./api.js";
import { resolveBenchSyncRuntimeConfig } from "./src/config.js";
import {
  CURSOR_STATE_MAX_ENTRIES,
  CURSOR_STATE_NAMESPACE,
  loadCursor,
  type BenchSyncCursorRow,
} from "./src/cursor.js";
import { createBenchSyncLoop } from "./src/loop.js";
import { resolveBenchSyncClient } from "./src/runtime-setup.js";
import { createMirrorBackoffState, runWorkboardMirrorTick } from "./src/workboard-mirror.js";

export default definePluginEntry({
  id: "bench-sync",
  name: "Bench Sync",
  description:
    "Mirror Workboard cards and skill proposals to the Bench cloud and apply governed directives.",
  register(api) {
    const loop = createBenchSyncLoop();
    api.registerService({
      id: "bench-sync",
      async start(ctx) {
        const runtime = resolveBenchSyncRuntimeConfig(ctx.config);
        if (!runtime.active) {
          ctx.logger.debug?.(`bench-sync: inactive (${runtime.inactiveReason}); loop not started`);
          return;
        }
        const cursorStore = api.runtime.state.openKeyedStore<BenchSyncCursorRow>({
          namespace: CURSOR_STATE_NAMESPACE,
          maxEntries: CURSOR_STATE_MAX_ENTRIES,
        });

        // One shared client for every handler (same origin-pin + auth path).
        const setup = await resolveBenchSyncClient({ config: ctx.config });
        if (setup.status !== "ok") {
          ctx.logger.info?.(`bench-sync: not starting loop — ${setup.reason}`);
          return;
        }

        // One durable cursor shared by all handlers; loaded once at start from
        // plugin state, then persisted by each handler after successful work.
        const runtimeCursor = {
          store: cursorStore,
          state: await loadCursor(cursorStore, ctx.logger),
        };

        if (runtime.workboardSyncEnabled) {
          // Open the SAME Workboard SQLite store the workboard plugin writes.
          // If the workboard DB/plugin is absent, opening throws or yields no
          // cards — either way we log once and skip rather than crash.
          let store: WorkboardStore | null = null;
          try {
            store = WorkboardStore.openSqlite();
          } catch (err) {
            ctx.logger.info?.(
              `bench-sync: workboard store unavailable; skipping workboard mirror (${
                err instanceof Error ? err.message : String(err)
              })`,
            );
          }
          if (store) {
            const backoff = createMirrorBackoffState();
            loop.addTickHandler({
              name: "workboard-mirror",
              run: async (tickCtx) => {
                await runWorkboardMirrorTick(
                  {
                    store,
                    client: setup.client,
                    cursorStore: runtimeCursor,
                    logger: tickCtx.logger,
                    signal: tickCtx.signal,
                  },
                  backoff,
                );
              },
            });
          }
        }

        loop.start({
          config: ctx.config,
          stateDir: ctx.stateDir,
          cursorStore,
          logger: ctx.logger,
          pollIntervalMs: runtime.pollIntervalMs,
        });
      },
      stop() {
        loop.stop();
      },
    });
  },
});
