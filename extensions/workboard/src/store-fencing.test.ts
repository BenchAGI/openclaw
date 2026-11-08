import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createConcurrentSqliteHarness } from "./test/sqlite-races.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard claim fencing", () => {
  it("fences an obsolete token when the same agent claims a new attempt", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Same agent, new attempt", status: "ready" });
    await store.claim(card.id, { ownerId: "worker", token: "old-attempt" });
    await store.reclaim(card.id, { status: "ready" }, null);

    const obsolete = { ownerId: "worker", token: "old-attempt" };
    const current = await store.claim(card.id, { ownerId: "worker", token: "new-attempt" });
    const staleWrites = [
      () => store.complete(card.id, { summary: "Late result" }, obsolete),
      () => store.addComment(card.id, { body: "Late progress" }, obsolete),
      () => store.move(card.id, "review", undefined, obsolete),
      () => store.block(card.id, { reason: "Late failure" }, obsolete),
      () => store.heartbeat(card.id, obsolete),
      () => store.releaseClaim(card.id, obsolete),
    ];
    for (const write of staleWrites) {
      await expect(write()).rejects.toThrow(/claimed by worker|token does not match/);
    }
    await expect(
      store.complete(card.id, { summary: "Token required" }, { ownerId: "worker" }),
    ).rejects.toThrow(/claimed by worker/);
    expect((await store.get(card.id))?.metadata?.claim).toEqual(current.card.metadata?.claim);
    await expect(
      store.complete(
        card.id,
        { summary: "Current result" },
        { ownerId: "worker", token: current.token },
      ),
    ).resolves.toMatchObject({ status: "done" });
    await expect(store.complete(card.id, { summary: "Late result" }, obsolete)).rejects.toThrow(
      /no longer claimed/,
    );
  });

  it("does not overwrite a replacement claim after completion awaits a child read", async () => {
    await using harness = createConcurrentSqliteHarness("openclaw-workboard-complete-takeover-");
    const { operation, host } = harness;
    const parent = await operation.create({ title: "Parent worker", status: "ready" });
    const old = await operation.claim(parent.id, { ownerId: "worker", token: "old-attempt" });
    const scope = { ownerId: "worker", token: old.token };
    const child = await operation.create({ title: "Child output", parents: [parent.id] }, scope);
    const reached = createDeferred<void>();
    const resume = createDeferred<void>();
    const get = operation.get.bind(operation);
    using readingChild = vi.spyOn(operation, "get").mockImplementation(async (id) => {
      if (id === child.id) {
        reached.resolve();
        await resume.promise;
      }
      return await get(id);
    });
    const completing = operation.complete(parent.id, { createdCardIds: [child.id] }, scope);
    const rejected = expect(completing).rejects.toThrow(/changed|conflict/i);
    await reached.promise;
    await host.reclaim(parent.id, { status: "ready" }, null);
    const current = await host.claim(parent.id, { ownerId: "worker", token: "new-attempt" });
    resume.resolve();
    await rejected;
    expect(readingChild).toHaveBeenCalledWith(child.id);
    expect((await host.get(parent.id))?.metadata?.claim).toEqual(current.card.metadata?.claim);
    expect((await host.get(parent.id))?.status).toBe("running");
  });
});
