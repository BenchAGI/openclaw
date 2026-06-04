import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import benchSyncPlugin from "./index.js";
import { CURSOR_STATE_MAX_ENTRIES, CURSOR_STATE_NAMESPACE } from "./src/cursor.js";

function makeLogger(): PluginLogger & { debugLines: string[] } {
  const debugLines: string[] = [];
  return {
    debugLines,
    debug: (m: string) => debugLines.push(m),
    info: () => {},
    warn: () => {},
    error: () => {},
  };
}

function createStore<T>(): PluginStateKeyedStore<T> {
  return {
    register: async () => {},
    registerIfAbsent: async () => true,
    update: async (_key, updateValue) => updateValue(undefined) !== undefined,
    lookup: async () => undefined,
    consume: async () => undefined,
    delete: async () => true,
    entries: async () => [],
    clear: async () => {},
  };
}

function activeConfig(): OpenClawConfig {
  return {
    gateway: {
      benchCloud: {
        enabled: true,
        workboardSync: { enabled: true, pollIntervalMs: 15_000 },
      },
    },
  } as OpenClawConfig;
}

function inactiveConfig(): OpenClawConfig {
  return { gateway: { benchCloud: { enabled: false } } } as OpenClawConfig;
}

function makeServiceContext(
  config: OpenClawConfig,
  logger: PluginLogger,
): OpenClawPluginServiceContext {
  return {
    config,
    stateDir: "/tmp/bench-sync-test-state",
    logger,
  };
}

function registerPlugin(openKeyedStore: OpenClawPluginApi["runtime"]["state"]["openKeyedStore"]) {
  let service: OpenClawPluginService | undefined;
  benchSyncPlugin.register(
    createTestPluginApi({
      id: "bench-sync",
      name: "bench-sync",
      runtime: {
        state: {
          resolveStateDir: () => "/tmp/bench-sync-test-state",
          openKeyedStore,
        },
      } as unknown as OpenClawPluginApi["runtime"],
      registerService: (nextService) => {
        service = nextService;
      },
    }),
  );
  if (!service) {
    throw new Error("bench-sync did not register its background service");
  }
  return service;
}

describe("bench-sync plugin service", () => {
  it("does not open cursor state when the sync loop is inactive", () => {
    const logger = makeLogger();
    const openKeyedStore = vi.fn(<T>(_options: OpenKeyedStoreOptions) => createStore<T>());
    const service = registerPlugin(openKeyedStore);

    void service.start(makeServiceContext(inactiveConfig(), logger));

    expect(openKeyedStore).not.toHaveBeenCalled();
    expect(logger.debugLines.some((line) => line.includes("inactive"))).toBe(true);
  });

  it("opens the SQLite plugin-state cursor namespace before starting the active loop", () => {
    const logger = makeLogger();
    const openKeyedStore = vi.fn(<T>(_options: OpenKeyedStoreOptions) => createStore<T>());
    const service = registerPlugin(openKeyedStore);
    const ctx = makeServiceContext(activeConfig(), logger);

    void service.start(ctx);
    void service.stop?.(ctx);

    expect(openKeyedStore).toHaveBeenCalledWith({
      namespace: CURSOR_STATE_NAMESPACE,
      maxEntries: CURSOR_STATE_MAX_ENTRIES,
    });
  });
});
