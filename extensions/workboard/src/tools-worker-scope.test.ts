import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawPluginToolContext } from "openclaw/plugin-sdk/plugin-entry";
import { describe, expect, it, vi } from "vitest";
import { workboardSessionKeyForCard } from "./session-link.js";
import { WorkboardStore } from "./store.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
  sqliteTestAuxStores,
} from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

async function workerFixture(
  store = createWorkboardSqliteTestStore(),
  options: { unassigned?: boolean; ownerId?: string } = {},
) {
  const card = await store.create({
    title: "Assigned work",
    ...(options.unassigned ? {} : { agentId: "cole" }),
    status: "ready",
  });
  const { token } = await store.claim(card.id, { ownerId: options.ownerId ?? "cole" });
  const sessionKey = workboardSessionKeyForCard(card);
  const prepared = await store.prepareExecutionLaunch(card.id, {
    requestedSessionKey: sessionKey,
    now: Date.now(),
    scope: { ownerId: "cole", token },
  });
  const toolsFor = (overrides: Partial<OpenClawPluginToolContext> = {}) => {
    const tools = new Map(
      createWorkboardTools({
        store,
        context: {
          agentId: "cole",
          sessionKey,
          config: { agents: { entries: { cole: {} } } },
          assertInvocationCurrent() {},
          ...overrides,
        },
      }).map((tool) => [tool.name, tool]),
    );
    return (name: string) => expectDefined(tools.get(name), name);
  };
  const accept = () =>
    store.acceptExecutionLaunch(card.id, {
      expectedLaunch: prepared.launch,
      expectedSessionKey: sessionKey,
      expectedRunId: prepared.launch.provisionalRunId,
      acceptedAt: Math.max(Date.now(), prepared.launch.preparedAt),
      sessionKey: sessionKey.startsWith("agent:") ? sessionKey : `agent:cole:${sessionKey}`,
      runId: "accepted-run",
      execution: {
        ...expectDefined(prepared.card.execution, "prepared execution"),
        sessionKey: sessionKey.startsWith("agent:") ? sessionKey : `agent:cole:${sessionKey}`,
        runId: "accepted-run",
      },
    });
  return {
    store,
    card: prepared.card,
    launch: prepared.launch,
    token,
    sessionKey,
    tool: toolsFor(),
    toolsFor,
    accept,
  };
}

async function rebindAcceptedRun(store: WorkboardStore, id: string) {
  const before = expectDefined(await store.get(id), "accepted card");
  expect(before.metadata?.automation?.launch).toMatchObject({
    phase: "accepted",
    acceptedRunId: "accepted-run",
  });
  expect(
    await store.syncLifecycle(id, {
      targetStatus: undefined,
      executionStatus: "running",
      sourceUpdatedAt: undefined,
      stale: undefined,
      now: Date.now(),
      association: {
        expectedSessionKey: before.sessionKey,
        expectedRunId: before.runId,
        sessionKey: expectDefined(before.sessionKey, "accepted session"),
        runId: "replacement-accepted-run",
      },
    }),
  ).toBe(true);
  const after = expectDefined(await store.get(id), "rebound card");
  expect(after).toMatchObject({
    runId: "replacement-accepted-run",
    execution: { runId: "replacement-accepted-run" },
    metadata: {
      automation: { launch: { phase: "accepted", acceptedRunId: "replacement-accepted-run" } },
    },
  });
  expect(after.metadata?.claim?.token).toBe(before.metadata?.claim?.token);
}

describe("claimed Workboard worker tools", () => {
  it("refuses a worker reading an unrelated card", async () => {
    const { store, tool, token } = await workerFixture();
    const foreign = await store.create({ title: "Unrelated planning work" });

    await expect(
      tool("workboard_read").execute("foreign-read", { id: foreign.id, token }),
    ).rejects.toThrow(/worker/i);
  });

  it("refuses a worker adding proof to an unclaimed unrelated card", async () => {
    const { store, tool } = await workerFixture();
    const foreign = await store.create({ title: "Unrelated planning work" });

    await expect(
      tool("workboard_proof").execute("foreign-proof", {
        id: foreign.id,
        label: "Unrelated acceptance",
        status: "passed",
      }),
    ).rejects.toThrow(/worker/i);
    expect((await store.get(foreign.id))?.metadata?.proof).toBeUndefined();
  });

  it("reads its own card and records all five proofs before completing", async () => {
    const { store, card, tool, token, accept } = await workerFixture();
    await accept();
    expect(await tool("workboard_read").execute("read", { id: card.id, token })).toMatchObject({
      details: { card: { id: card.id } },
    });
    const labels = [
      "Criterion one",
      "Criterion two",
      "Criterion three",
      "Evidence one",
      "Evidence two",
    ];
    for (const label of labels) {
      await tool("workboard_proof").execute("proof", {
        id: card.id,
        token,
        label,
        status: "passed",
      });
    }
    await tool("workboard_heartbeat").execute("heartbeat", { id: card.id, token });
    await tool("workboard_complete").execute("complete", {
      id: card.id,
      token,
      summary: "Verified",
    });
    const completed = await store.get(card.id);
    expect(completed?.status).toBe("done");
    expect(completed?.metadata?.proof?.map((proof) => proof.label)).toEqual(labels);
    expect(completed?.metadata?.claim).toBeUndefined();
  });

  it.each([
    "workboard_read",
    "workboard_proof",
    "workboard_heartbeat",
    "workboard_complete",
    "workboard_block",
  ])("%s refuses missing and replaced tokens, including same-agent takeover", async (name) => {
    const { store, card, tool, token } = await workerFixture();
    await expect(tool(name).execute("missing", { id: card.id })).rejects.toThrow(/claimed/);
    await store.reclaim(card.id);
    const replacement = await store.claim(card.id, { ownerId: "cole" });
    expect(replacement.token).not.toBe(token);
    await expect(tool(name).execute("stale", { id: card.id, token })).rejects.toThrow(
      /worker|claimed/i,
    );
  });

  it.each(["workboard_heartbeat", "workboard_complete", "workboard_block"])(
    "%s cannot mutate an unrelated unclaimed card",
    async (name) => {
      const { store, tool } = await workerFixture();
      const foreign = await store.create({ title: "Unclaimed foreign work" });
      await expect(tool(name).execute("foreign", { id: foreign.id })).rejects.toThrow(/worker/i);
      expect(await store.get(foreign.id)).toEqual(foreign);
    },
  );

  it.each(["agent", "missing-agent", "session", "run", "missing-launch", "revoked-invocation"])(
    "refuses an inconsistent %s association",
    async (change) => {
      const { store, card, tool, toolsFor, token, sessionKey, accept } = await workerFixture();
      await accept();
      let read = tool("workboard_read");
      if (change === "agent") {
        read = toolsFor({ agentId: "sage" })("workboard_read");
      }
      if (change === "missing-agent") {
        read = toolsFor({ agentId: undefined })("workboard_read");
      }
      if (change === "session") {
        read = toolsFor({ sessionKey: `${sessionKey}-foreign` })("workboard_read");
      }
      if (change === "run") {
        const current = expectDefined(await store.get(card.id), "current card");
        await store.update(card.id, { execution: { ...current.execution, runId: "another-run" } });
      }
      if (change === "missing-launch") {
        const manual = await store.create({
          title: "Manually linked",
          agentId: "cole",
          sessionKey,
        });
        const claimed = await store.claim(manual.id, { ownerId: "other-owner" });
        await expect(
          read.execute("manual", { id: manual.id, token: claimed.token }),
        ).rejects.toThrow(/worker/i);
        return;
      }
      if (change === "revoked-invocation") {
        read = toolsFor({
          assertInvocationCurrent() {
            throw new Error("Invocation ended");
          },
        })("workboard_read");
      }
      await expect(read.execute("mismatch", { id: card.id, token })).rejects.toThrow(
        /worker|Invocation/i,
      );
    },
  );

  it("allows default-agent canonicalization and an intentional claim owner override", async () => {
    const { card, token, tool, accept } = await workerFixture(undefined, {
      unassigned: true,
      ownerId: "dispatch-owner",
    });
    await accept();
    await expect(
      tool("workboard_read").execute("default", { id: card.id, token }),
    ).resolves.toBeDefined();
  });

  it("uses the explicit worker assignment in a canonical multi-agent roster", async () => {
    const { card, token, toolsFor } = await workerFixture();
    const read = toolsFor({ config: { agents: { entries: { cole: {}, sage: {} } } } })(
      "workboard_read",
    );
    await expect(read.execute("multi-agent", { id: card.id, token })).resolves.toBeDefined();
  });

  it("does not guess a default for unassigned work in an ambiguous canonical roster", async () => {
    const { card, token, toolsFor } = await workerFixture(undefined, { unassigned: true });
    const read = toolsFor({ config: { agents: { entries: { cole: {}, sage: {} } } } })(
      "workboard_read",
    );
    await expect(read.execute("ambiguous-default", { id: card.id, token })).rejects.toThrow(
      /Multiple agents/,
    );
  });

  it.each(["takeover", "execution", "coherent-rebind", "assignment", "reassignment"])(
    "refuses %s during asynchronous context construction",
    async (change) => {
      const { store, card, tool, token, accept } = await workerFixture();
      if (change === "coherent-rebind") {
        await accept();
      }
      const build = store.buildWorkerContext.bind(store);
      using contextRead = vi.spyOn(store, "buildWorkerContext");
      contextRead.mockImplementationOnce(async (id) => {
        const context = await build(id);
        if (change === "takeover") {
          await store.reclaim(id);
          await store.claim(id, { ownerId: "cole" });
        } else if (change === "assignment") {
          await store.update(id, { agentId: null });
        } else if (change === "reassignment") {
          await store.update(id, { agentId: "sage" });
        } else if (change === "coherent-rebind") {
          await rebindAcceptedRun(store, id);
        } else {
          await store.update(id, {
            execution: { ...card.execution, runId: "changed-during-read" },
          });
        }
        return context;
      });
      await expect(
        tool("workboard_read").execute("late-read", { id: card.id, token }),
      ).rejects.toThrow(/worker|claimed/i);
    },
  );

  it("allows prepare-to-accept while an authorized read materializes", async () => {
    const { store, card, tool, token, accept } = await workerFixture();
    const build = store.buildWorkerContext.bind(store);
    using contextRead = vi.spyOn(store, "buildWorkerContext");
    contextRead.mockImplementationOnce(async (id) => {
      const context = await build(id);
      await accept();
      return context;
    });
    await expect(
      tool("workboard_read").execute("accepted", { id: card.id, token }),
    ).resolves.toMatchObject({
      details: { card: { runId: "accepted-run" } },
    });
  });

  it.each([300_000, 300_001])(
    "preserves the native heartbeat grace boundary at +%ims",
    async (age) => {
      const { store, card, tool, token } = await workerFixture();
      const expiresAt = expectDefined(card.metadata?.claim?.expiresAt, "claim expiry");
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(expiresAt + age);
      const heartbeat = tool("workboard_heartbeat").execute("grace", { id: card.id, token });
      if (age === 300_000) {
        await expect(heartbeat).resolves.toBeDefined();
        expect((await store.get(card.id))?.metadata?.claim?.lastHeartbeatAt).toBe(expiresAt + age);
      } else {
        await expect(heartbeat).rejects.toThrow(/worker/i);
        expect(await store.get(card.id)).toEqual(card);
      }
    },
  );

  it.each(["workboard_proof", "workboard_heartbeat", "workboard_complete", "workboard_block"])(
    "%s cannot commit after its owning invocation ends during the SQLite write await",
    async (name) => {
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      let heldId: string | undefined = undefined;
      let current = true;
      const store = createWorkboardSqliteTestStore({
        beforeCardWrite: async (id) => {
          if (id === heldId) {
            entered.resolve();
            await resume.promise;
          }
        },
      });
      const { card, token, toolsFor } = await workerFixture(store);
      const tool = toolsFor({
        assertInvocationCurrent() {
          if (!current) {
            throw new Error("Owning invocation ended");
          }
        },
      })(name);
      heldId = card.id;
      const write = tool.execute("held-write", {
        id: card.id,
        token,
        label: "Held proof",
        status: "passed",
      });
      const rejected = expect(write).rejects.toThrow("Owning invocation ended");
      await entered.promise;
      current = false;
      resume.resolve();
      await rejected;
      expect(await store.get(card.id)).toEqual(card);
    },
  );

  it.each(["takeover", "coherent-rebind"])(
    "rechecks %s when queued proof reaches the SQLite mutation",
    async (change) => {
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      const queued = createDeferred<void>();
      let blockingId: string | undefined = undefined;
      const { store, stores } = createWorkboardSqliteTestHarness({
        beforeCardWrite: async (id) => {
          if (id === blockingId) {
            entered.resolve();
            await resume.promise;
          }
        },
      });
      const { card, tool, token, accept } = await workerFixture(store);
      if (change === "coherent-rebind") {
        await accept();
      }
      const blocker = await store.create({ title: "Queue predecessor" });
      blockingId = blocker.id;
      const blocking = store.addComment(blocker.id, { body: "Hold this store queue" });
      await entered.promise;
      const addProof = store.addProof.bind(store);
      using proofEntry = vi.spyOn(store, "addProof");
      proofEntry.mockImplementationOnce((...args) => {
        queued.resolve();
        return addProof(...args);
      });
      const proof = tool("workboard_proof").execute("queued-proof", {
        id: card.id,
        token,
        label: "Late proof",
        status: "passed",
      });
      const rejected = expect(proof).rejects.toThrow(/worker|claimed/i);
      try {
        await queued.promise;
        const other = new WorkboardStore(stores.cards, sqliteTestAuxStores(stores));
        if (change === "coherent-rebind") {
          await rebindAcceptedRun(other, card.id);
        } else {
          await other.reclaim(card.id);
          await other.claim(card.id, { ownerId: "cole" });
        }
        await other.close();
      } finally {
        resume.resolve();
      }
      await blocking;
      await rejected;
      expect((await store.get(card.id))?.metadata?.proof).toBeUndefined();
    },
  );

  it("preserves ordinary-main planning reads/proof and single inline completion", async () => {
    const store = createWorkboardSqliteTestStore();
    const tools = new Map(
      createWorkboardTools({
        store,
        context: { agentId: "cole", sessionKey: "agent:cole:main" },
      }).map((tool) => [tool.name, tool]),
    );
    const card = await store.create({ title: "Ordinary planning" });
    await expect(
      expectDefined(tools.get("workboard_read"), "read").execute("read", { id: card.id }),
    ).resolves.toBeDefined();
    await expect(
      expectDefined(tools.get("workboard_proof"), "proof").execute("proof", {
        id: card.id,
        label: "Planning evidence",
        status: "passed",
      }),
    ).resolves.toBeDefined();
    const { token } = await store.claim(card.id, { ownerId: "cole" });
    await expect(
      expectDefined(tools.get("workboard_complete"), "complete").execute("complete", {
        id: card.id,
        token,
        proof: { label: "Inline evidence", status: "passed" },
      }),
    ).resolves.toMatchObject({ details: { card: { status: "done" } } });
  });
});
