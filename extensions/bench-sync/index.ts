// bench-sync — additive fork plugin that mirrors local Workboard cards and
// skill proposals up to the Bench cloud and applies governed directives down.
//
// B1 (this PR): plugin scaffold. The service registers a background polling
// loop whose tick handlers are empty for now; the workboard up-mirror (B2) and
// directive pull/apply (B3) modules slot into the `tick` handler array without
// changing this file's loop structure.

import { definePluginEntry } from "./api.js";
import { resolveBenchSyncRuntimeConfig } from "./src/config.js";
import {
  CURSOR_STATE_MAX_ENTRIES,
  CURSOR_STATE_NAMESPACE,
  type BenchSyncCursorRow,
} from "./src/cursor.js";
import { createBenchSyncLoop } from "./src/loop.js";

export default definePluginEntry({
  id: "bench-sync",
  name: "Bench Sync",
  description:
    "Mirror Workboard cards and skill proposals to the Bench cloud and apply governed directives.",
  register(api) {
    const loop = createBenchSyncLoop();
    api.registerService({
      id: "bench-sync",
      start(ctx) {
        const runtime = resolveBenchSyncRuntimeConfig(ctx.config);
        if (!runtime.active) {
          ctx.logger.debug?.(`bench-sync: inactive (${runtime.inactiveReason}); loop not started`);
          return;
        }
        const cursorStore = api.runtime.state.openKeyedStore<BenchSyncCursorRow>({
          namespace: CURSOR_STATE_NAMESPACE,
          maxEntries: CURSOR_STATE_MAX_ENTRIES,
        });
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
