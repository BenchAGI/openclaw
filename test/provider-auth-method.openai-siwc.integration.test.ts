import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { Server as NetServer } from "node:net";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { buildOpenAIProvider } from "../extensions/openai/api.js";
import { createFileLockManager } from "../src/infra/file-lock-manager.js";
import { runProviderPluginAuthMethodUnpersisted } from "../src/plugins/provider-auth-method.js";
import { createNonExitingRuntime } from "../src/runtime.js";
import { acquireTestPortBlock } from "../src/test-utils/port-claims.js";
import { WizardSession } from "../src/wizard/session.js";

const guardedFetch = vi.hoisted(() => vi.fn());
const loopback = vi.hoisted<{ port: number; boundPorts: number[] }>(() => ({
  port: 0,
  boundPorts: [],
}));
vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({ fetchWithSsrFGuard: guardedFetch }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/provider-auth-runtime")>();
  return {
    ...actual,
    startProviderOAuthLoopbackCallbackServer: async (
      params: Parameters<typeof actual.startProviderOAuthLoopbackCallbackServer>[0],
    ) => {
      const redirectUrl = new URL(params.redirectUrl);
      redirectUrl.port = String(loopback.port);
      const server = await actual.startProviderOAuthLoopbackCallbackServer({
        ...params,
        redirectUrl,
      });
      loopback.boundPorts.push(Number(redirectUrl.port));
      return server;
    },
  };
});

function captureLocalListenerMetadata() {
  // Inspect only this existing manager's held-entry metadata; never acquire/release/reset here.
  const portClaims = createFileLockManager("openclaw.test-gateway-ports");
  const events: object[] = [];
  const servers: Array<{ id: number; server: NetServer }> = [];
  const ids = new WeakMap<NetServer, number>();
  let sequence = 0;
  let nextId = 1;
  let droppedEvents = 0;
  let droppedServers = 0;
  let captureErrors = 0;
  const claim = (port: number) => {
    try {
      const entries = portClaims
        .heldEntries()
        .filter(
          (entry) => path.basename(entry.normalizedTargetPath) === `openclaw-test-port-${port}`,
        );
      return {
        selectedPort: port,
        matchingHeldEntries: entries.length,
        entries: entries.slice(0, 4).map((entry) => {
          let sidecar: object;
          try {
            const value = lstatSync(entry.lockPath);
            sidecar = {
              status: "present",
              device: value.dev,
              inode: value.ino,
              uid: value.uid,
              mode: value.mode,
              nlink: value.nlink,
              bytes: value.size,
              regular: value.isFile(),
              symlink: value.isSymbolicLink(),
            };
          } catch (error) {
            sidecar = {
              status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unobserved",
            };
          }
          return {
            targetPathSha256: createHash("sha256").update(entry.normalizedTargetPath).digest("hex"),
            acquiredAt: Number.isFinite(entry.acquiredAt) ? entry.acquiredAt : null,
            sidecar,
          };
        }),
        droppedEntries: Math.max(0, entries.length - 4),
      };
    } catch {
      captureErrors++;
      return { selectedPort: port, status: "unobserved" };
    }
  };
  const address = (server: NetServer) => {
    try {
      const value = server.address();
      if (value == null) {
        return { kind: "unbound" };
      }
      if (typeof value === "string") {
        return { kind: "ipc-value-withheld" };
      }
      return {
        kind: "tcp",
        port: value.port,
        host: ["127.0.0.1", "::1", "localhost"].includes(value.address)
          ? value.address
          : "other-value-withheld",
      };
    } catch {
      return { kind: "unobserved" };
    }
  };
  const id = (server: NetServer) => {
    let value = ids.get(server);
    if (value === undefined) {
      value = nextId++;
      ids.set(server, value);
      if (servers.length === 16) {
        servers.shift();
        droppedServers++;
      }
      servers.push({ id: value, server });
    }
    return value;
  };
  const record = (kind: string, server?: NetServer, fields: object = {}) => {
    try {
      const row = {
        sequence: sequence++,
        kind,
        ...(server
          ? { id: id(server), listening: server.listening, address: address(server) }
          : {}),
        ...fields,
      };
      if (events.length === 64) {
        events.shift();
        droppedEvents++;
      }
      events.push(row);
    } catch {
      captureErrors++;
    }
  };
  // oxlint-disable-next-line typescript/unbound-method -- Capture before spying; Reflect.apply below supplies the actual server receiver.
  const originalListen = NetServer.prototype.listen;
  // oxlint-disable-next-line typescript/unbound-method -- Capture before spying; Reflect.apply below supplies the actual server receiver.
  const originalClose = NetServer.prototype.close;
  // oxlint-disable-next-line typescript/unbound-method -- Capture before spying; Reflect.apply below supplies the actual server receiver.
  const originalEmit = NetServer.prototype.emit;
  const restorers: Array<() => void> = [];
  try {
    const listen = vi.spyOn(NetServer.prototype, "listen").mockImplementation(function (
      this: NetServer,
      ...args: Parameters<NetServer["listen"]>
    ) {
      const first = args[0] as unknown;
      const candidate =
        typeof first === "object" && first !== null && "port" in first
          ? (first as { port: unknown }).port
          : first;
      const port =
        typeof candidate === "number" &&
        Number.isInteger(candidate) &&
        candidate >= 0 &&
        candidate <= 65535
          ? candidate
          : null;
      record("listen-called", this, {
        requestedPort: port,
        sourceStack:
          new Error().stack?.split("\n").slice(1, 5).join("\n").slice(0, 768) ?? "unavailable",
      });
      return Reflect.apply(originalListen, this, args);
    });
    restorers.push(() => listen.mockRestore());
    const close = vi.spyOn(NetServer.prototype, "close").mockImplementation(function (
      this: NetServer,
      ...args: Parameters<NetServer["close"]>
    ) {
      record("close-called", this);
      return Reflect.apply(originalClose, this, args);
    });
    restorers.push(() => close.mockRestore());
    const emit = vi.spyOn(NetServer.prototype, "emit").mockImplementation(function (
      this: NetServer,
      event: string | symbol,
      ...args: unknown[]
    ) {
      if (event === "listening" || event === "close") {
        record("event-" + event, this);
      }
      if (event === "error") {
        const candidate = args[0] as { code?: unknown } | undefined;
        const code =
          typeof candidate?.code === "string" &&
          ["EADDRINUSE", "EACCES", "EPERM", "ECONNRESET", "ERR_SERVER_NOT_RUNNING"].includes(
            candidate.code,
          )
            ? candidate.code
            : "OTHER";
        record("event-error", this, { code });
      }
      // Observe emit without adding an error listener; native thrown-error behavior is retained.
      return Reflect.apply(originalEmit, this, [event, ...args]);
    });
    restorers.push(() => emit.mockRestore());
  } catch (error) {
    for (const restore of restorers.toReversed()) {
      restore();
    }
    throw error;
  }
  return {
    mark(label: string, port: number) {
      record(label, undefined, {
        selectedPort: port,
        claim: claim(port),
        knownServers: servers.map(({ id: value, server }) => ({
          id: value,
          listening: server.listening,
          address: address(server),
        })),
      });
    },
    finish() {
      for (const restore of restorers.toReversed()) {
        restore();
      }
      return {
        schema: "bench.siwc-local-listener-diagnostic/v1",
        events,
        droppedEvents,
        droppedServers,
        captureErrors,
        workerPid: process.pid,
        workerParentPid: process.ppid,
        retainedMaximumEvents: 64,
        retainedMaximumServers: 16,
        sourceStackMaximumUtf16Units: 768,
        callbackArgumentsUrlsStatesOrCredentialValuesExported: false,
        foreignProcessOwnershipClaimed: false,
        hostedSocketCauseClaimed: false,
      };
    },
  };
}

async function withSiwcListenerDiagnostic<T>(
  body: (trace: ReturnType<typeof captureLocalListenerMetadata>) => Promise<T>,
): Promise<T> {
  const trace = captureLocalListenerMetadata();
  let failed = false;
  let failure: unknown;
  let result: T | undefined;
  let context!: ReturnType<typeof trace.finish>;
  try {
    result = await body(trace);
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    // Restore native methods before attaching context or rethrowing the original failure.
    context = trace.finish();
  }
  if (failed) {
    const bounded = { ...context, events: [...context.events], droppedContextEvents: 0 };
    let serialized = JSON.stringify(bounded);
    while (serialized.length > 32768 && bounded.events.length > 0) {
      bounded.events.shift();
      bounded.droppedContextEvents++;
      serialized = JSON.stringify(bounded);
    }
    if (failure instanceof Error) {
      try {
        failure.message += "\nSIWC_CALLBACK_LIFECYCLE_CONTEXT " + serialized;
      } catch {
        // Read-only/custom errors retain their original identity and failure.
      }
    }
    throw failure;
  }
  return result as T;
}

async function exerciseNativeClaimedListener(
  trace: ReturnType<typeof captureLocalListenerMetadata>,
  privateMarker?: string,
) {
  const claim = await acquireTestPortBlock({ offsets: [0] });
  const listener = new NetServer();
  trace.mark("claim-acquired", claim.port);
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      const returned = listener.listen(claim.port, "127.0.0.1", function (this: NetServer) {
        listener.off("error", reject);
        expect(this).toBe(listener);
        resolve();
      });
      expect(returned).toBe(listener);
    });
    expect(listener.listening).toBe(true);
    trace.mark("control-listener-bound", claim.port);
    if (privateMarker) {
      const payload = { privateFixtureValue: privateMarker };
      const synthetic = Object.assign(new Error(privateMarker), { code: "EPERM" });
      listener.once("error", function (this: NetServer, error: unknown, received: unknown) {
        expect(this).toBe(listener);
        expect(error).toBe(synthetic);
        expect(received).toBe(payload);
      });
      // A deliberate event checks delegation/privacy; it is not a real socket failure.
      listener.emit("error", synthetic, payload);
    }
    await new Promise<void>((resolve, reject) => {
      const returned = listener.close((error) => (error ? reject(error) : resolve()));
      expect(returned).toBe(listener);
    });
    expect(listener.listening).toBe(false);
  } finally {
    if (listener.listening) {
      await new Promise<void>((resolve, reject) => {
        listener.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await claim.release();
    trace.mark("sessions-and-claim-released", claim.port);
  }
}

it("releases the SIWC callback port when OAuth expires before the wizard note is acknowledged", async () => {
  const method = buildOpenAIProvider().auth.find((entry) => entry.id === "siwc");
  if (!method) {
    throw new Error("OpenAI did not register its SIWC method");
  }
  await withSiwcListenerDiagnostic(async (listenerTrace) => {
    // Retain ownership across the close/rebind gap; a leaked listener must still fail.
    const portClaim = await acquireTestPortBlock({ offsets: [0] });
    loopback.port = portClaim.port;
    loopback.boundPorts = [];
    listenerTrace.mark("claim-acquired", loopback.port);
    const timeout = new AbortController();
    const timeoutSignal = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(timeout.signal);
    const start = () =>
      new WizardSession(async (prompter, signal) => {
        await runProviderPluginAuthMethodUnpersisted({
          config: {},
          runtime: createNonExitingRuntime(),
          method,
          prompter,
          signal,
          existingProfiles: [],
          isRemote: false,
        });
      });
    const session = start();
    let retry: WizardSession | undefined;
    try {
      const pending = await session.next();
      expect(pending.step).toMatchObject({
        type: "note",
        externalUrl: expect.stringContaining("/api/accounts/authorize?"),
      });
      expect(timeoutSignal).toHaveBeenCalledWith(5 * 60_000);
      // Expire OAuth while the longer-lived wizard still awaits acknowledgement.
      timeout.abort(new DOMException("Sign-in timed out", "TimeoutError"));
      // Retry only after the expired runner has released its callback listener.
      await session.whenSettled();
      listenerTrace.mark("first-session-settled", loopback.port);
      expect(await session.next()).toMatchObject({
        done: true,
        status: "error",
        error: "Login cancelled",
      });

      listenerTrace.mark("before-retry-start", loopback.port);
      retry = start();
      // SIWC publishes this note only after its callback listener has bound successfully.
      const retried = await retry.next();
      listenerTrace.mark("after-retry-next", loopback.port);
      expect(retried, retry.getError()).toMatchObject({
        done: false,
        step: {
          type: "note",
          externalUrl: expect.stringContaining("/api/accounts/authorize?"),
        },
      });
      expect(loopback.port).toBeGreaterThan(0);
      expect(loopback.boundPorts).toEqual([loopback.port, loopback.port]);
      expect(guardedFetch).not.toHaveBeenCalled();
    } finally {
      session.cancel();
      retry?.cancel();
      await Promise.all([session.whenSettled(), retry?.whenSettled()]);
      timeoutSignal.mockRestore();
      await portClaim.release();
      listenerTrace.mark("sessions-and-claim-released", loopback.port);
    }
  });
});

it("retains native listener/claim cleanup and attaches only safe failure context after restoring methods", async () => {
  const before = {
    // oxlint-disable-next-line typescript/unbound-method -- Snapshot method identity only; no unbound invocation.
    listen: NetServer.prototype.listen,
    // oxlint-disable-next-line typescript/unbound-method -- Snapshot method identity only; no unbound invocation.
    close: NetServer.prototype.close,
    // oxlint-disable-next-line typescript/unbound-method -- Snapshot method identity only; no unbound invocation.
    emit: NetServer.prototype.emit,
  };
  const consoleError = vi.spyOn(console, "error");
  try {
    expect(
      await withSiwcListenerDiagnostic(async (trace) => {
        await exerciseNativeClaimedListener(trace);
        return "native-success";
      }),
    ).toBe("native-success");
    expect(consoleError).not.toHaveBeenCalled();
    let originalFailure: unknown;
    try {
      expect("controlled actual").toBe("controlled expected");
    } catch (error) {
      originalFailure = error;
    }
    const marker = "private-fixture-payload-not-diagnostic-43a9";
    let caught: unknown;
    try {
      await withSiwcListenerDiagnostic(async (trace) => {
        await exerciseNativeClaimedListener(trace, marker);
        throw originalFailure;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(originalFailure);
    // oxlint-disable-next-line typescript/unbound-method -- Compare method identity only; no unbound invocation.
    expect(NetServer.prototype.listen).toBe(before.listen);
    // oxlint-disable-next-line typescript/unbound-method -- Compare method identity only; no unbound invocation.
    expect(NetServer.prototype.close).toBe(before.close);
    // oxlint-disable-next-line typescript/unbound-method -- Compare method identity only; no unbound invocation.
    expect(NetServer.prototype.emit).toBe(before.emit);
    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain("SIWC_CALLBACK_LIFECYCLE_CONTEXT ");
    expect(message).not.toContain(marker);
    const contextText = message.split("SIWC_CALLBACK_LIFECYCLE_CONTEXT ")[1];
    if (contextText === undefined) {
      throw new Error("SIWC lifecycle context missing from controlled failure");
    }
    const context = JSON.parse(contextText) as {
      workerPid: number;
      events: Array<{ kind: string; claim?: { matchingHeldEntries: number } }>;
    };
    expect(context.workerPid).toBe(process.pid);
    expect(context.events.some((event) => event.kind === "event-listening")).toBe(true);
    expect(context.events.some((event) => event.kind === "event-close")).toBe(true);
    expect(
      context.events.find((event) => event.kind === "control-listener-bound")?.claim
        ?.matchingHeldEntries,
    ).toBe(1);
    expect(
      context.events.find((event) => event.kind === "sessions-and-claim-released")?.claim
        ?.matchingHeldEntries,
    ).toBe(0);
    expect(contextText.length).toBeLessThanOrEqual(32768);
    expect(consoleError).not.toHaveBeenCalled();
  } finally {
    consoleError.mockRestore();
  }
});
