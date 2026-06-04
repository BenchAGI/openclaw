// bench-sync background polling loop skeleton.
//
// B1: the loop just emits a debug heartbeat each tick. The mirror (B2) and
// directive-apply (B3) modules register as `tick` handlers — each is an async
// fn that gets the shared BenchSyncTickContext. Handlers run sequentially and
// in isolation: one failing handler logs and does not abort the others or the
// loop. This keeps the followup PRs a pure additive `handlers.push(...)`.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginLogger } from "openclaw/plugin-sdk/plugin-entry";

export type BenchSyncTickContext = {
  config: OpenClawConfig;
  stateDir: string;
  logger: PluginLogger;
  /** Aborted when the service stops; handlers should honor it for I/O. */
  signal: AbortSignal;
  /** Monotonic tick counter starting at 1. */
  tick: number;
};

/** A unit of per-tick work (B2 mirror, B3 directive-apply, ...). */
export type BenchSyncTickHandler = {
  name: string;
  run: (ctx: BenchSyncTickContext) => void | Promise<void>;
};

export type BenchSyncLoopStartOptions = {
  config: OpenClawConfig;
  stateDir: string;
  logger: PluginLogger;
  pollIntervalMs: number;
};

export type BenchSyncLoop = {
  /** Register a tick handler (followup PRs slot mirror/directive-apply here). */
  addTickHandler: (handler: BenchSyncTickHandler) => void;
  start: (options: BenchSyncLoopStartOptions) => void;
  stop: () => void;
  /** Run exactly one tick now (used by tests and by start()'s timer). */
  runTickOnce: (options: BenchSyncLoopStartOptions, abort: AbortController) => Promise<void>;
  isRunning: () => boolean;
};

export function createBenchSyncLoop(initialHandlers: BenchSyncTickHandler[] = []): BenchSyncLoop {
  const handlers: BenchSyncTickHandler[] = [...initialHandlers];
  let timer: ReturnType<typeof setInterval> | null = null;
  let abortController: AbortController | null = null;
  let tickCount = 0;
  let ticking = false;

  async function runTickOnce(
    options: BenchSyncLoopStartOptions,
    abort: AbortController,
  ): Promise<void> {
    if (abort.signal.aborted) {
      return;
    }
    // Avoid overlapping ticks if a previous tick is still running.
    if (ticking) {
      options.logger.debug?.("bench-sync: previous tick still running; skipping this interval");
      return;
    }
    ticking = true;
    tickCount += 1;
    const ctx: BenchSyncTickContext = {
      config: options.config,
      stateDir: options.stateDir,
      logger: options.logger,
      signal: abort.signal,
      tick: tickCount,
    };
    options.logger.debug?.(
      `bench-sync: heartbeat tick #${ctx.tick} (handlers: ${handlers.length})`,
    );
    try {
      for (const handler of handlers) {
        if (abort.signal.aborted) {
          break;
        }
        try {
          await handler.run(ctx);
        } catch (err) {
          options.logger.warn(
            `bench-sync: tick handler "${handler.name}" failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    } finally {
      ticking = false;
    }
  }

  return {
    addTickHandler(handler) {
      handlers.push(handler);
    },
    start(options) {
      if (timer) {
        // Already running; ignore duplicate start.
        return;
      }
      abortController = new AbortController();
      const abort = abortController;
      options.logger.info(
        `bench-sync: starting sync loop (interval ${options.pollIntervalMs}ms, handlers: ${handlers.length})`,
      );
      timer = setInterval(() => {
        void runTickOnce(options, abort);
      }, options.pollIntervalMs);
      // Do not keep the process alive solely for this timer.
      timer.unref?.();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      abortController?.abort();
      abortController = null;
    },
    runTickOnce,
    isRunning() {
      return timer !== null;
    },
  };
}
