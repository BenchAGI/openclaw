import { describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { createGatewayMethodCapture } from "./test/gateway-methods.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import { createWorkboardTools } from "./tools.js";

describe("Workboard exact-start authority", () => {
  it("advertises and admits a versioned exact-card start with its native deadline", async () => {
    const { api, methods, invoke } = createGatewayMethodCapture();
    let workerToken: string | undefined;
    const run = vi.fn(async ({ message }: { message: string }) => {
      workerToken = message.match(/^Claim token: (.+)$/m)?.[1];
      return { runId: "bounded-run" };
    });
    api.runtime.subagent = { run } as never;
    api.runtime.sandbox = { prepareWorkspaceAuthority: vi.fn() } as never;
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Bounded exact worker",
      status: "ready",
      boardId: "crew",
      agentId: "worker",
      tenant: "bench",
      workspace: { kind: "scratch" },
      workspaceAccess: { unrestricted: true },
      maxRuntimeSeconds: 7,
    });
    const other = await store.create({
      title: "Other ready worker",
      status: "ready",
      priority: "urgent",
      agentId: "other",
      boardId: "crew",
    });
    registerWorkboardGatewayMethods({ api, store });
    const boards = await invoke("workboard.boards.list", {});
    expect(boards.mock.calls[0]?.[1]).toMatchObject({
      capabilities: {
        scopedExactStartVersion: 1,
        enforcedWorkerDeadlineVersion: 1,
        claimTokenFencingVersion: 1,
      },
    });
    const respond = vi.fn();
    await methods.get("workboard.cards.start")!.handler({
      params: {
        id: card.id,
        expectedUpdatedAt: card.updatedAt,
        expectedAuthority: {
          boardId: "crew",
          agentId: "worker",
          tenant: "bench",
          workspace: { kind: "scratch" },
          maxRuntimeSeconds: 7,
        },
      },
      context: { getRuntimeConfig: () => ({}) },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        cardId: card.id,
        runId: "bounded-run",
        sessionKey: expect.any(String),
        card: expect.objectContaining({ id: card.id, status: "running", runId: "bounded-run" }),
      }),
    );
    expect(run).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ timeoutSeconds: 7 }));
    expect((await store.get(card.id))?.execution?.runId).toBe("bounded-run");
    expect((await store.get(other.id))?.status).toBe("ready");
    expect(workerToken).toEqual(expect.any(String));
    const tools = new Map(
      createWorkboardTools({ store, context: { agentId: "worker" } }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    await tools
      .get("workboard_heartbeat")!
      .execute("live-worker", { id: card.id, token: workerToken });
    await invoke("workboard.cards.reclaim", { id: card.id, status: "ready" });
    const replacement = await tools.get("workboard_claim")!.execute("replacement", { id: card.id });
    const currentToken = (replacement.details as { token: string }).token;
    expect(currentToken).not.toBe(workerToken);
    const complete = tools.get("workboard_complete")!;
    await expect(
      complete.execute("old-worker", { id: card.id, token: workerToken, summary: "Late result" }),
    ).rejects.toThrow(/claimed by worker/);
    await expect(
      complete.execute("missing-token", { id: card.id, summary: "Agent identity alone" }),
    ).rejects.toThrow(/claimed by worker/);
    await complete.execute("current-worker", { id: card.id, token: currentToken, summary: "Done" });
    expect((await store.get(card.id))?.status).toBe("done");
  });

  it.each(["stale version", "wrong authority", "edited during preflight"])(
    "rejects scoped exact start with %s before claiming or running",
    async (change) => {
      using clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(1_000);
      const { api, methods } = createGatewayMethodCapture();
      const run = vi.fn();
      api.runtime.subagent = { run } as never;
      api.runtime.sandbox = { prepareWorkspaceAuthority: vi.fn() } as never;
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({
        title: "Approved worker",
        notes: "Approved acceptance and budget",
        status: "ready",
        boardId: "crew",
        agentId: "worker",
        tenant: "bench",
        workspace: { kind: "scratch" },
        workspaceAccess: { unrestricted: true },
        maxRuntimeSeconds: 7,
      });
      const expectedAuthority = {
        boardId: "crew",
        agentId: "worker",
        tenant: change === "wrong authority" ? "foreign" : "bench",
        workspace: { kind: "scratch" },
        maxRuntimeSeconds: 7,
      };
      const claim = store.claim.bind(store);
      using claiming = vi.spyOn(store, "claim").mockImplementation(async (id, input, options) => {
        if (change === "edited during preflight") {
          await store.update(id, { notes: "Replaced acceptance" });
        }
        return await claim(id, input, options);
      });
      if (change === "stale version") {
        const edited = await store.update(card.id, { notes: "Replaced acceptance" });
        expect(edited.updatedAt).toBeGreaterThan(card.updatedAt);
        expect(Date.now()).toBe(card.createdAt);
      }
      registerWorkboardGatewayMethods({ api, store });
      const respond = vi.fn();
      await methods.get("workboard.cards.start")!.handler({
        params: { id: card.id, expectedUpdatedAt: card.updatedAt, expectedAuthority },
        context: { getRuntimeConfig: () => ({}) },
        respond,
      } as never);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(run).not.toHaveBeenCalled();
      expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
      expect((await store.get(card.id))?.status).toBe("ready");
      if (change === "edited during preflight") {
        expect(claiming).toHaveBeenCalledOnce();
        expect((await store.get(card.id))?.notes).toBe("Replaced acceptance");
      }
    },
  );

  it("refuses scoped starts on an older host without enforced subagent deadlines", async () => {
    const { api, methods, invoke } = createGatewayMethodCapture({ capabilities: [] });
    const run = vi.fn();
    api.runtime.subagent = { run } as never;
    const store = createWorkboardSqliteTestStore();
    const authority = {
      boardId: "crew",
      agentId: "worker",
      tenant: "bench",
      workspace: { kind: "scratch" },
      maxRuntimeSeconds: 7,
    };
    const card = await store.create({ ...authority, title: "Old host", status: "ready" });
    registerWorkboardGatewayMethods({ api, store });
    const boards = await invoke("workboard.boards.list", {});
    expect(boards.mock.calls[0]?.[1]?.capabilities?.enforcedWorkerDeadlineVersion).toBe(0);
    const respond = vi.fn();
    await methods.get("workboard.cards.start")!.handler({
      params: { id: card.id, expectedUpdatedAt: card.updatedAt, expectedAuthority: authority },
      context: { getRuntimeConfig: () => ({}) },
      respond,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ message: expect.stringMatching(/host.*deadline/i) }),
    );
    expect(run).not.toHaveBeenCalled();
    expect(await store.get(card.id)).toEqual(card);
  });
});
