import { getEventListeners } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { expect, it, vi } from "vitest";
import { getPreparedModelCatalogWorkerPoolSnapshot } from "../agents/prepared-model-catalog-worker.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
  registerPreparedModelRuntimePublicationListener,
} from "../agents/prepared-model-runtime.js";
import { registerPreparedModelRuntimeClose } from "../agents/prepared-model-runtime.lifecycle.js";
import { getPreparedModelRuntimeStartupStatus } from "../agents/prepared-model-runtime.startup-status.js";
import { createAuditEventWriter as createIdleAuditWriter } from "../audit/audit-event-writer.js";
import { readConfigFileSnapshot } from "../config/io.js";
import { GATEWAY_SHUTDOWN_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { flushLogger, setLoggerOverride } from "../logging/logger.js";
import { getPluginValueInstance } from "../plugins/plugin-instance-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runOutsideOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { publishConfiguredModelRuntimeSnapshots } from "./server-startup-model-runtime.js";

const auditMaintenance = vi.hoisted(() => ({
  gate: undefined as { entered: () => void; release: Promise<void> } | undefined,
}));

// Observe only the partial fake-clock window; native handles and their methods stay intact.
function traceTimeoutRegistrations() {
  const pending = new Map<
    ReturnType<typeof setTimeout>,
    { delayMs: number | undefined; sourceStack: string | undefined }
  >();
  let droppedRegistrations = 0;
  const schedule = globalThis.setTimeout;
  const cancel = globalThis.clearTimeout;
  const observedTimeout = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    ...params: Parameters<typeof setTimeout>
  ) => {
    const [callback, delay, ...args] = params;
    const record =
      pending.size < 32
        ? {
            delayMs: delay,
            sourceStack: new Error().stack?.split("\n").slice(1, 11).join("\n").slice(0, 2_048),
          }
        : undefined;
    if (!record) {
      droppedRegistrations++;
    }
    const id = schedule(function (this: unknown) {
      pending.delete(id);
      return Reflect.apply(callback, this, args);
    }, delay);
    if (record) {
      pending.set(id, record);
    }
    return id;
  }) as typeof setTimeout);
  const observedClear = vi.spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
    pending.delete(id as ReturnType<typeof setTimeout>);
    return cancel(id);
  });
  return {
    assertNoTimers() {
      try {
        expect(vi.getTimerCount()).toBe(0);
      } catch (error) {
        if (error instanceof Error) {
          error.message += `\nTimeout registration context: ${JSON.stringify({
            pending: [...pending].map(([id, record]) => ({
              id: Number(id),
              delayMs: record.delayMs,
              sourceStack: record.sourceStack,
            })),
            droppedRegistrations,
            coverage:
              "Registration candidates only: excludes preexisting timers, may miss refresh after firing, and does not observe handle-method cancellation.",
          })}`;
        }
        throw error;
      }
    },
    restore() {
      observedTimeout.mockRestore();
      observedClear.mockRestore();
    },
  };
}

it.each(["final Gateway", "live sibling", "closing sibling"] as const)(
  "joins managed reload acquisition during close with a %s",
  async (scope) => {
    const fixture = await createGatewayMetadataCloseFixture("managed-model-close");
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    fixture.config.gateway = { reload: { mode: "hybrid" } };
    fixture.config.agents = {
      defaults: { workspace: fixture.state.workspaceDir, model: `${fixture.pluginId}/before` },
      entries: { main: { workspace: fixture.state.workspaceDir } },
    };
    const entered = createDeferredCore();
    const cancelled = createDeferredCore();
    const finishAcquisition = createDeferredCore();
    const escape = createDeferredCore();
    const reloaderStopEntered = createDeferredCore();
    let armed = false;
    let acquisitionSignal: AbortSignal | undefined;
    let acquisitionFinished = false;
    let closeFinished = false;
    let closing: Promise<void> | undefined;
    let siblingClosing: Promise<void> | undefined;
    const missingModelChunk = vi.fn(() => {
      throw Object.assign(new Error("rotated model-runtime chunk"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });
    const restorers: Array<() => void> = [];
    const bridgeKey = `__managed_model_close_${path.basename(fixture.state.root)}`;
    Object.defineProperty(globalThis, bridgeKey, {
      configurable: true,
      value: async (signal: AbortSignal) => {
        if (!armed) {
          return;
        }
        acquisitionSignal = signal;
        const onAbort = () => cancelled.resolve();
        signal.addEventListener("abort", onAbort, { once: true });
        entered.resolve();
        try {
          await Promise.race([cancelled.promise, escape.promise]);
          await finishAcquisition.promise;
        } finally {
          signal.removeEventListener("abort", onAbort);
          acquisitionFinished = true;
        }
      },
    });
    await fs.writeFile(
      path.join(fixture.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: fixture.pluginId,
        providers: [fixture.pluginId],
        providerCatalogEntry: "./catalog.cjs",
        configSchema: { type: "object", properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(fixture.rootDir, "catalog.cjs"),
      `module.exports = { id: ${JSON.stringify(fixture.pluginId)}, label: "Reload acquisition fixture", auth: [],
      staticCatalog: { async run(ctx) {
        await globalThis[${JSON.stringify(bridgeKey)}](ctx.signal);
        return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
          models: ["before", "after"].map(id => ({ id, name: id, reasoning: false, input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 })) } };
      } }
    };`,
    );
    try {
      const siblingPort = scope !== "final Gateway" ? await fixture.reservePort() : undefined;
      const siblingServer =
        siblingPort !== undefined ? await fixture.start(siblingPort) : undefined;
      if (siblingPort !== undefined) {
        // Keep a real serving sibling without a second watcher replacing this publication.
        await fixture.kernels.get(siblingPort)!.runtimeState.configReloader.stop();
      }
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      const kernel = fixture.kernels.get(port)!;
      const reloader = kernel.runtimeState.configReloader;
      const stopReloader = reloader.stop.bind(reloader);
      const observedStop = vi.spyOn(reloader, "stop").mockImplementation(() => {
        reloaderStopEntered.resolve();
        return stopReloader();
      });
      restorers.push(() => observedStop.mockRestore());
      const snapshot = await readConfigFileSnapshot();
      armed = true;
      await fixture.state.writeConfig({
        ...snapshot.sourceConfig,
        agents: {
          ...snapshot.sourceConfig.agents,
          defaults: {
            ...snapshot.sourceConfig.agents?.defaults,
            model: `${fixture.pluginId}/after`,
          },
        },
      });
      await entered.promise;
      expect(acquisitionSignal?.aborted).toBe(false);
      if (scope === "final Gateway") {
        vi.doMock("../agents/prepared-model-runtime.js", missingModelChunk);
        await expect(import("../agents/prepared-model-runtime.js")).rejects.toThrow();
        expect(missingModelChunk).toHaveBeenCalledOnce();
        missingModelChunk.mockClear();
      }
      closing = server.close({ reason: "managed model acquisition fixture" }).finally(() => {
        closeFinished = true;
      });
      void closing.catch(() => {});
      await Promise.race([
        reloaderStopEntered.promise,
        closing.then(() => {
          throw new Error("Gateway close did not stop its reloader");
        }),
      ]);
      if (scope === "final Gateway") {
        expect(acquisitionSignal?.aborted).toBe(true);
        expect(() => refreshPreparedModelRuntimeSnapshots(snapshot.sourceConfig)).toThrow(
          /shutdown/,
        );
      } else if (scope === "closing sibling") {
        const siblingReloader = fixture.kernels.get(siblingPort!)!.runtimeState.configReloader;
        const stopSiblingReloader = siblingReloader.stop.bind(siblingReloader);
        const siblingStopEntered = createDeferredCore();
        const observedSiblingStop = vi.spyOn(siblingReloader, "stop").mockImplementation(() => {
          siblingStopEntered.resolve();
          return stopSiblingReloader();
        });
        restorers.push(() => observedSiblingStop.mockRestore());
        siblingClosing = siblingServer!.close({ reason: "close final sibling" });
        void siblingClosing.catch(() => {});
        await Promise.race([
          siblingStopEntered.promise,
          siblingClosing.then(() => {
            throw new Error("Sibling close did not stop its reloader");
          }),
        ]);
        expect(acquisitionSignal?.aborted).toBe(true);
      }
      expect(acquisitionFinished).toBe(false);
      expect(closeFinished).toBe(false);
      escape.resolve();
      finishAcquisition.resolve();
      await Promise.all([closing, siblingClosing]);
      expect(acquisitionFinished).toBe(true);
      expect(missingModelChunk).not.toHaveBeenCalled();
      armed = false;
      if (scope === "live sibling") {
        const context = fixture.kernels.get(siblingPort!)!.gatewayRequestContext;
        expect(context.resolveGatewayContext?.()).toBe(context);
        expect(context.getRuntimeConfig().agents?.defaults?.model).toBe(
          `${fixture.pluginId}/after`,
        );
        await expect(context.loadGatewayModelCatalog({ agentId: "main" })).resolves.toContainEqual(
          expect.objectContaining({ provider: fixture.pluginId, id: "after" }),
        );
        const dispatch = await loadPublishedGatewayReplyDispatchRuntime({ agentId: "main" });
        expect(dispatch).toBeDefined();
        await using lease = await acquireAgentRunPreparedModelRuntime(
          {
            agentId: "main",
            agentDir: dispatch!.agentDir,
            config: dispatch!.config,
            workspaceDir: dispatch!.workspaceDir,
            allowGatewaySubagentBinding: true,
          },
          { pluginGeneration: dispatch!.pluginGeneration },
        );
        expect(lease.snapshot.isCurrent()).toBe(true);
        expect(lease.snapshot.config.agents?.defaults?.model).toBe(`${fixture.pluginId}/after`);
      }
    } finally {
      armed = false;
      escape.resolve();
      finishAcquisition.resolve();
      await Promise.allSettled([closing, siblingClosing]);
      vi.doUnmock("../agents/prepared-model-runtime.js");
      try {
        await fixture.cleanup();
      } finally {
        restorers.toReversed().forEach((restore) => restore());
        Reflect.deleteProperty(globalThis, bridgeKey);
      }
    }
  },
);

vi.mock("../audit/audit-event-writer.js", async (importOriginal) => {
  const { createAuditEventWriter } =
    await importOriginal<typeof import("../audit/audit-event-writer.js")>();
  return {
    createAuditEventWriter: (...args: Parameters<typeof createAuditEventWriter>) => {
      const writer = createAuditEventWriter(...args);
      const gate = auditMaintenance.gate;
      return gate
        ? {
            ...writer,
            ready: writer.ready.then(async () => {
              gate.entered();
              await gate.release;
            }),
          }
        : writer;
    },
  };
});

it.each(["static catalog", "synthetic auth"] as const)(
  "Gateway shutdown joins degraded %s acquisition and registered plugin cleanup outcomes",
  async (phase) => {
    const fixture = await createGatewayMetadataCloseFixture("degraded-model-close");
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const closingEntered = createDeferredCore();
    const finishAcquisition = createDeferredCore();
    const cleanupEntered = createDeferredCore();
    const finishCleanup = createDeferredCore();
    const cleanupFailure =
      phase === "synthetic auth" ? new Error("registered acquisition cleanup failed") : undefined;
    let cleanupFinished = false;
    let closeFinished = false;
    const workers: Worker[] = [];
    const timers = new Set<ReturnType<typeof setInterval>>();
    let acquisitionSignal: AbortSignal | undefined;
    let acquisitions = 0;
    let joined = false;
    let completePublications = 0;
    const bridgeKey = `__degraded_model_close_${path.basename(fixture.state.root)}`;
    const acquire = async (signal: AbortSignal | undefined) => {
      if (++acquisitions !== 2) {
        return;
      }
      acquisitionSignal = signal;
      const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
      workers.push(worker);
      const timer = setInterval(() => {}, 1000);
      timers.add(timer);
      const cancel = () => release.resolve();
      signal?.addEventListener("abort", cancel, { once: true });
      entered.resolve();
      try {
        await release.promise;
        await finishAcquisition.promise;
      } finally {
        signal?.removeEventListener("abort", cancel);
        clearInterval(timer);
        timers.delete(timer);
        await worker.terminate();
        joined = true;
      }
      // A cooperative hook may return after abort; the host must still reject its stale facts.
    };
    Object.defineProperty(globalThis, bridgeKey, { configurable: true, value: acquire });
    const provider = fixture.pluginId;
    await fs.writeFile(
      path.join(fixture.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: provider,
        providers: [provider],
        providerCatalogEntry: "./catalog.cjs",
        configSchema: { type: "object", properties: {} },
      }),
    );
    await fs.writeFile(
      path.join(fixture.rootDir, "catalog.cjs"),
      `module.exports = { id: ${JSON.stringify(provider)}, label: "Acquisition fixture", auth: [],
        staticCatalog: { async run(ctx) {
          ${phase === "static catalog" ? `await globalThis[${JSON.stringify(bridgeKey)}](ctx.signal);` : ""}
          return { provider: { api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
            models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024 }] } };
        } },
        ${phase === "synthetic auth" ? `async prepareSyntheticAuth(ctx) { await globalThis[${JSON.stringify(bridgeKey)}](ctx.signal); return { apiKey: "synthetic-fixture-key" }; },` : ""}
      };`,
    );
    fixture.config.agents = {
      ownership: "explicit",
      defaults: {
        workspace: fixture.state.workspaceDir,
        model: `${provider}/model`,
        heartbeat: { agentId: "main" },
        systemAgent: { agentId: "main" },
      },
      entries: {
        main: { workspace: fixture.state.workspaceDir },
        late: { workspace: fixture.state.path("late-workspace") },
      },
    };
    fixture.config.talk = { agentId: "main" };
    const unsubscribe = registerPreparedModelRuntimePublicationListener(({ phase: event }) => {
      if (event === "published" && getPreparedModelRuntimeStartupStatus()?.degraded === false) {
        completePublications++;
      }
    });
    const unregisterClose = registerPreparedModelRuntimeClose(async () => {
      closingEntered.resolve();
    });
    let closing: Promise<void> | undefined;
    let publication: Promise<void> | undefined;
    let timerTracing: ReturnType<typeof traceTimeoutRegistrations> | undefined;
    const logFile = fixture.state.path("shutdown.log");
    setLoggerOverride({ file: logFile, level: "debug", consoleLevel: "silent" });
    try {
      const port = await fixture.reservePort();
      const server = await fixture.start(port);
      const metadata = fixture.kernels.get(port)?.getPluginMetadataSnapshot();
      expect(metadata).toBeDefined();
      const callback = fixture.loadCallback(metadata!);
      const callbackOwner = getPluginValueInstance(callback);
      expect(callbackOwner).toBeDefined();
      callbackOwner!.lifecycle.onDispose(async () => {
        cleanupEntered.resolve();
        expect(joined).toBe(true);
        await finishCleanup.promise;
        cleanupFinished = true;
        if (cleanupFailure) {
          throw cleanupFailure;
        }
      });
      expect(process.listenerCount(fixture.event)).toBe(fixture.listeners + 1);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      timerTracing = traceTimeoutRegistrations();
      publication = publishConfiguredModelRuntimeSnapshots({ cfg: fixture.config });
      await Promise.race([
        entered.promise,
        publication.then(() => {
          throw new Error("Startup bypassed held provider acquisition");
        }),
      ]);
      await vi.advanceTimersByTimeAsync(120_000);
      await publication;
      expect(getPreparedModelRuntimeStartupStatus()).toMatchObject({
        degraded: true,
        pendingAgents: ["late"],
      });
      timerTracing.assertNoTimers();
      timerTracing.restore();
      timerTracing = undefined;
      vi.useRealTimers();
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
      const startedAt = performance.now();
      closing = server.close({ reason: "degraded acquisition fixture" }).finally(() => {
        closeFinished = true;
      });
      void closing.catch(() => {});
      await closingEntered.promise;
      await nextTurn();
      expect(acquisitionSignal?.aborted).toBe(true);
      expect(joined).toBe(false);
      expect(callbackOwner!.lifecycle.signal.aborted).toBe(false);
      expect(closeFinished).toBe(false);
      finishAcquisition.resolve();
      await Promise.race([
        cleanupEntered.promise,
        closing.then(() => {
          throw new Error("Gateway close bypassed registered plugin cleanup");
        }),
      ]);
      await nextTurn();
      expect(callbackOwner!.lifecycle.signal.aborted).toBe(true);
      expect(cleanupFinished).toBe(false);
      expect(closeFinished).toBe(false);
      finishCleanup.resolve();
      await closing;
      if (cleanupFailure) {
        await flushLogger();
        expect(await fs.readFile(logFile, "utf8")).toContain(
          `Plugin ${fixture.pluginId} cleanup failed (instance): ${cleanupFailure.message}`,
        );
      }
      expect(cleanupFinished).toBe(true);
      expect(process.listenerCount(fixture.event)).toBe(fixture.listeners);
      expect(() => callback()).toThrow(/retir|disabled|reloaded/);
      expect(performance.now() - startedAt).toBeLessThan(GATEWAY_SHUTDOWN_TIMEOUT_MS);
      expect(joined).toBe(true);
      expect(timers.size).toBe(0);
      expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
      expect(getEventListeners(acquisitionSignal!, "abort")).toHaveLength(0);
      expect(getPreparedModelCatalogWorkerPoolSnapshot()).toMatchObject({
        workers: 0,
        activeTasks: 0,
        pendingTasks: 0,
      });
      expect(completePublications).toBe(0);
      expect(getPreparedModelRuntimeStartupStatus()?.degraded).not.toBe(false);
      await expect(fetch(`http://127.0.0.1:${port}/readyz`)).rejects.toThrow();
    } finally {
      timerTracing?.restore();
      vi.useRealTimers();
      release.resolve();
      finishAcquisition.resolve();
      finishCleanup.resolve();
      await Promise.allSettled([publication, closing]);
      await Promise.all(
        workers.filter((worker) => worker.threadId !== -1).map((worker) => worker.terminate()),
      );
      for (const timer of timers) {
        clearInterval(timer);
      }
      unregisterClose();
      unsubscribe();
      await fixture.cleanup().finally(() => setLoggerOverride(null));
      Reflect.deleteProperty(globalThis, bridgeKey);
    }
  },
);

it("joins initial audit maintenance before metadata fixture callers replace timers", async () => {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const gatewayReady = createDeferredCore();
  auditMaintenance.gate = { entered: () => entered.resolve(), release: release.promise };
  const fixture = await createGatewayMetadataCloseFixture("audit-ready-before-clock");
  const serverModule = await import("./server-start.js");
  const start = serverModule.startGatewayServerCore;
  const nativeStartup = vi
    .spyOn(serverModule, "startGatewayServerCore")
    .mockImplementation(async (...args) => {
      const server = await start(...args);
      await server.startupSettled;
      gatewayReady.resolve();
      return server;
    });
  let starting: ReturnType<typeof fixture.start> | undefined;
  let returned = false;
  try {
    const port = await fixture.reservePort();
    starting = fixture.start(port).then((server) => {
      returned = true;
      return server;
    });
    await Promise.race([
      Promise.all([entered.promise, gatewayReady.promise]),
      starting.then(() => {
        throw new Error("Gateway fixture returned before audit maintenance readiness");
      }),
    ]);
    await nextTurn();
    expect(returned).toBe(false);
    release.resolve();
    await starting;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    release.resolve();
    await Promise.allSettled([starting]);
    auditMaintenance.gate = undefined;
    nativeStartup.mockRestore();
    await fixture.cleanup();
  }
});

it("preserves timer firing, refresh, cancellation and callback values while tracing", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const schedule = globalThis.setTimeout;
  const payload = { privateFixtureValue: "callback-arguments-not-in-context" };
  const nativeCallback = vi.fn(function (this: unknown, ...args: unknown[]) {
    return { receiver: this, args };
  });
  const nativeHandle = schedule(nativeCallback, 10, payload, "second-argument");
  const tracing = traceTimeoutRegistrations();
  const callback = vi.fn(function (this: unknown, ...args: unknown[]) {
    return { receiver: this, args };
  });
  try {
    const handle = setTimeout(callback, 10, payload, "second-argument");
    expect(handle.unref()).toBe(handle);
    expect(handle.ref()).toBe(handle);
    let failure: unknown;
    try {
      tracing.assertNoTimers();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("Timeout registration context:");
    expect(message).not.toContain("callback-arguments-not-in-context");
    expect(message).not.toContain("privateFixtureValue");
    expect(message).not.toContain("second-argument");
    await vi.advanceTimersByTimeAsync(5);
    expect(nativeHandle.refresh()).toBe(nativeHandle);
    expect(handle.refresh()).toBe(handle);
    await vi.advanceTimersByTimeAsync(5);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5);
    expect(callback).toHaveBeenCalledOnce();
    const nativeResult = nativeCallback.mock.results[0]?.value;
    const result = callback.mock.results[0]?.value;
    if (!nativeResult || !result) {
      throw new Error("Timer callbacks did not return their receiver and arguments");
    }
    expect(
      result.receiver === (nativeResult.receiver === nativeHandle ? handle : nativeResult.receiver),
    ).toBe(true);
    expect(result.args).toEqual([payload, "second-argument"]);
    tracing.assertNoTimers();
    const cancelled = setTimeout(callback, 10, payload, "second-argument");
    clearTimeout(cancelled);
    await vi.advanceTimersByTimeAsync(10);
    expect(callback).toHaveBeenCalledOnce();
    tracing.assertNoTimers();
    const overflow = Array.from({ length: 33 }, () => setTimeout(callback, 10, payload));
    expect(() => tracing.assertNoTimers()).toThrow('"droppedRegistrations":1');
    overflow.forEach((timer) => clearTimeout(timer));
    tracing.assertNoTimers();
  } finally {
    tracing.restore();
    vi.useRealTimers();
  }
});

it("reports a real shared-state idle timer only when the zero-timer assertion fails", async () => {
  const state = await createOpenClawTestState({ label: "timer-registration-context" });
  const errors: string[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const tracing = traceTimeoutRegistrations();
  const writer = runOutsideOpenClawDatabaseMaintenanceScope(() =>
    createIdleAuditWriter({
      stateDir: state.stateDir,
      scheduler: createTestGatewayScheduler(),
      onError: (error) => errors.push(error),
    }),
  );
  try {
    await writer.ready;
    expect(errors).toEqual([]);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    let failure: unknown;
    try {
      tracing.assertNoTimers();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain('"delayMs":60000');
    expect(message).toContain("openclaw-state-worker-owner.ts");
    expect(message).toContain('"id":');
    expect(message).toContain('"droppedRegistrations":0');
    await writer.stop();
    await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
    tracing.assertNoTimers();
  } finally {
    try {
      await writer.stop();
      await closeOpenClawStateDatabaseByPathAsync(resolveOpenClawStateSqlitePath(state.env));
    } finally {
      tracing.restore();
      vi.useRealTimers();
      await state.cleanup();
    }
  }
});
