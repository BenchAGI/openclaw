import { describe, expect, it, vi } from "vitest";
import type { WorkboardCard } from "../../workboard/src/types.js";
import { BenchSyncClient } from "./client.js";
import {
  defaultCursorState,
  loadCursor,
  type BenchSyncCursorRow,
  type BenchSyncCursorState,
  type BenchSyncCursorStore,
} from "./cursor.js";
import {
  computeContentHash,
  createMirrorBackoffState,
  projectCardForCloud,
  runWorkboardMirrorTick,
  type ProjectedCard,
  type WorkboardCardSource,
} from "./workboard-mirror.js";

const BASE = "https://benchagi.example";
const INSTANCE = "jBA5cCK6fyMCzIk3SoWF";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(fetchFn: typeof fetch): BenchSyncClient {
  return new BenchSyncClient(
    { apiBaseUrl: BASE, instanceId: INSTANCE, apiKey: "bench_test_secret" },
    { fetchFn },
  );
}

function baseCard(overrides: Partial<WorkboardCard> = {}): WorkboardCard {
  return {
    id: "card-1",
    title: "Ship the thing",
    status: "running",
    priority: "high",
    labels: [],
    position: 1,
    createdAt: 1_000,
    updatedAt: 2_000,
    ...overrides,
  };
}

function fixtureStore(cards: WorkboardCard[]): WorkboardCardSource {
  return { list: async () => cards };
}

function createMemoryCursorStore(): BenchSyncCursorStore {
  const rows = new Map<string, BenchSyncCursorRow>();
  return {
    delete: async (key) => rows.delete(key),
    entries: async () => [...rows].map(([key, value]) => ({ key, value })),
    register: async (key, value) => void rows.set(key, value),
  };
}

function cursorStore(state: BenchSyncCursorState = defaultCursorState()) {
  return { store: createMemoryCursorStore(), state };
}

describe("projectCardForCloud", () => {
  it("maps core card fields to the cloud agent-task payload", () => {
    const card = baseCard({
      id: "abc",
      title: "T",
      notes: "n",
      status: "review",
      priority: "urgent",
      labels: ["alpha", "beta"],
      agentId: "cole",
      runId: "run-9",
      sessionKey: "agent:cole:1",
      updatedAt: 5_000,
      metadata: { automation: { boardId: "planning" } },
    });
    const projected = projectCardForCloud(card);
    expect(projected).toMatchObject({
      gatewayCardId: "abc",
      boardId: "planning",
      title: "T",
      notes: "n",
      status: "review",
      priority: "urgent",
      labels: ["alpha", "beta"],
      assigneeAgentId: "cole",
      linkedRunId: "run-9",
      linkedSessionKey: "agent:cole:1",
      gatewayUpdatedAt: 5_000,
    });
  });

  it("redacts the claim token — only owner/timestamps/stale cross the wire", () => {
    const card = baseCard({
      metadata: {
        claim: {
          ownerId: "agent:cole:1",
          token: "SUPER_SECRET_TOKEN",
          claimedAt: 100,
          lastHeartbeatAt: 200,
        },
        stale: { detectedAt: 300, reason: "no heartbeat" },
      },
    });
    const projected = projectCardForCloud(card);
    expect(projected?.claim).toEqual({
      owner: "agent:cole:1",
      claimedAt: 100,
      lastHeartbeatAt: 200,
      stale: true,
    });
    // The token must not appear anywhere in the serialized payload.
    expect(JSON.stringify(projected)).not.toContain("SUPER_SECRET_TOKEN");
    expect(JSON.stringify(projected)).not.toContain("token");
  });

  it("marks claim stale=false when no stale-state marker is present", () => {
    const card = baseCard({
      metadata: {
        claim: { ownerId: "o", token: "t", claimedAt: 1, lastHeartbeatAt: 2 },
      },
    });
    expect(projectCardForCloud(card)?.claim?.stale).toBe(false);
  });

  it("returns null for cards labeled internal (never leave the machine)", () => {
    expect(projectCardForCloud(baseCard({ labels: ["internal"] }))).toBeNull();
  });

  it("returns null for cards with metadata.visibility === 'internal'", () => {
    const card = baseCard({
      metadata: { visibility: "internal" } as WorkboardCard["metadata"],
    });
    expect(projectCardForCloud(card)).toBeNull();
  });

  it("never includes attachment blobs or attachment metadata", () => {
    const card = baseCard({
      metadata: {
        attachments: [
          {
            id: "att-1",
            cardId: "card-1",
            createdAt: 1,
            fileName: "leak.bin",
            byteSize: 1024,
          },
        ],
      },
    });
    const projected = projectCardForCloud(card);
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain("leak.bin");
    expect(serialized).not.toContain("attachment");
    expect(serialized).not.toContain("att-1");
  });

  it("maps comments to {id,author,body,at,kind} with the card agent as author", () => {
    const card = baseCard({
      agentId: "piper",
      metadata: {
        comments: [{ id: "c1", body: "looks good", createdAt: 42 }],
      },
    });
    const projected = projectCardForCloud(card);
    expect(projected?.comments).toEqual([
      { id: "c1", author: "piper", body: "looks good", at: 42, kind: "comment" },
    ]);
  });

  it("maps attempts and surfaces the rolling failure count on the last attempt", () => {
    const card = baseCard({
      metadata: {
        attempts: [
          {
            id: "a1",
            status: "failed",
            startedAt: 1,
            endedAt: 2,
            engine: "codex",
            mode: "autonomous",
            model: "gpt-5.5",
            runId: "run-1",
          },
        ],
        failureCount: 3,
      },
    });
    const projected = projectCardForCloud(card);
    expect(projected?.attempts).toEqual([
      {
        engine: "codex",
        mode: "autonomous",
        model: "gpt-5.5",
        runId: "run-1",
        status: "failed",
        startedAt: 1,
        endedAt: 2,
        failureCount: 3,
      },
    ]);
  });

  it("derives parent/child task ids from dependency links", () => {
    const card = baseCard({
      metadata: {
        links: [
          { id: "l1", type: "parent", createdAt: 1, targetCardId: "p1" },
          { id: "l2", type: "child", createdAt: 1, targetCardId: "c1" },
          { id: "l3", type: "child", createdAt: 1, targetCardId: "c2" },
          { id: "l4", type: "relates_to", createdAt: 1, targetCardId: "x" },
        ],
      },
    });
    const projected = projectCardForCloud(card);
    expect(projected?.parentTaskIds).toEqual(["p1"]);
    expect(projected?.childTaskIds).toEqual(["c1", "c2"]);
  });

  it("maps proof/artifact/diagnostics into ref + diagnostic shapes", () => {
    const card = baseCard({
      metadata: {
        proof: [{ id: "pr1", status: "passed", createdAt: 1, label: "tests", url: "http://x" }],
        artifacts: [{ id: "ar1", createdAt: 2, label: "build", url: "http://y" }],
        diagnostics: [
          {
            kind: "repeated_failures",
            severity: "error",
            title: "Repeated failures",
            detail: "3 fails",
            firstSeenAt: 5,
            lastSeenAt: 9,
            count: 3,
            actions: [],
          },
        ],
      },
    });
    const projected = projectCardForCloud(card);
    expect(projected?.proofRefs).toEqual([
      { kind: "passed", label: "tests", ref: "http://x", at: 1 },
    ]);
    expect(projected?.artifactRefs).toEqual([
      { kind: "artifact", label: "build", ref: "http://y", at: 2 },
    ]);
    expect(projected?.diagnostics).toEqual([
      { code: "repeated_failures", detail: "3 fails", at: 9 },
    ]);
  });
});

describe("computeContentHash", () => {
  it("is stable regardless of key insertion order", () => {
    const a = {
      gatewayCardId: "x",
      title: "t",
      status: "todo",
      priority: "normal",
      gatewayUpdatedAt: 1,
    } as ProjectedCard;
    const b = {
      gatewayUpdatedAt: 1,
      priority: "normal",
      status: "todo",
      title: "t",
      gatewayCardId: "x",
    } as ProjectedCard;
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  it("changes when any field changes", () => {
    const a = projectCardForCloud(baseCard({ title: "one" }))!;
    const b = projectCardForCloud(baseCard({ title: "two" }))!;
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  it("is order-independent for nested arrays/objects", () => {
    const card = baseCard({
      metadata: {
        claim: { ownerId: "o", token: "t", claimedAt: 1, lastHeartbeatAt: 2 },
        comments: [{ id: "c1", body: "x", createdAt: 1 }],
      },
    });
    const projected = projectCardForCloud(card)!;
    // Re-projecting the same card yields the same hash.
    expect(computeContentHash(projected)).toBe(computeContentHash(projectCardForCloud(card)!));
  });
});

describe("runWorkboardMirrorTick", () => {
  it("sends zero POSTs when nothing changed since the last sync", async () => {
    const card = baseCard();
    // The cursor stores the hash of the seq-less projection (syncCursor is a
    // per-push counter, not card content).
    const hash = computeContentHash(projectCardForCloud(card)!);
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);
    const store = cursorStore({
      ...defaultCursorState(),
      cards: { [card.id]: { hash, seq: 1 } },
    });

    const result = await runWorkboardMirrorTick({
      store: fixtureStore([card]),
      client,
      cursorStore: store,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(0);
    expect(result.batches).toBe(0);
  });

  it("pushes a changed card in one batched POST and advances the cursor", async () => {
    const card = baseCard();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, upserted: 1 }));
    const client = makeClient(fetchMock);
    const store = cursorStore();

    const result = await runWorkboardMirrorTick({
      store: fixtureStore([card]),
      client,
      cursorStore: store,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.changed).toBe(1);
    expect(result.batches).toBe(1);

    // The POST body carries the single projected card with a syncCursor seq.
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.cards).toHaveLength(1);
    expect(body.cards[0]).toMatchObject({ gatewayCardId: "card-1", syncCursor: 1 });

    // Cursor advanced + persisted to plugin state.
    expect(store.state.cards["card-1"]?.seq).toBe(1);
    const reloaded = await loadCursor(store.store);
    expect(reloaded.cards["card-1"]).toEqual(store.state.cards["card-1"]);
  });

  it("resumes after a simulated restart — no re-push of unchanged cards", async () => {
    const card = baseCard();
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);
    const first = cursorStore();
    await runWorkboardMirrorTick({ store: fixtureStore([card]), client, cursorStore: first });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Restart: fresh runtime cursor loaded from plugin state, same card.
    const reloaded = await loadCursor(first.store);
    const second = { store: first.store, state: reloaded };
    const result = await runWorkboardMirrorTick({
      store: fixtureStore([card]),
      client,
      cursorStore: second,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1); // no second POST
    expect(result.changed).toBe(0);
  });

  it("does NOT advance the cursor on POST failure and retries next tick", async () => {
    const card = baseCard();
    const failingFetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "boom" }), { status: 503 }),
    );
    const client = makeClient(failingFetch);
    const store = cursorStore();
    const backoff = createMirrorBackoffState();

    const failed = await runWorkboardMirrorTick(
      { store: fixtureStore([card]), client, cursorStore: store },
      backoff,
    );
    expect(failed.failed).toBe(true);
    expect(store.state.cards["card-1"]).toBeUndefined();
    expect(backoff.consecutiveFailures).toBe(1);
    expect(backoff.skipTicksRemaining).toBe(1);
  });

  it("arms a skip-N-ticks backoff gate that grows with consecutive failures", async () => {
    const card = baseCard();
    const failingFetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ error: "boom" }), { status: 503 }),
    );
    const client = makeClient(failingFetch);
    const store = cursorStore();
    const backoff = createMirrorBackoffState();

    // Tick 1: fails, arms skip=1.
    await runWorkboardMirrorTick(
      { store: fixtureStore([card]), client, cursorStore: store },
      backoff,
    );
    expect(backoff.skipTicksRemaining).toBe(1);
    expect(failingFetch).toHaveBeenCalledTimes(1);

    // Tick 2: skipped by the gate (no POST attempted).
    const skipped = await runWorkboardMirrorTick(
      { store: fixtureStore([card]), client, cursorStore: store },
      backoff,
    );
    expect(skipped.skipped).toBe(true);
    expect(failingFetch).toHaveBeenCalledTimes(1);
    expect(backoff.skipTicksRemaining).toBe(0);

    // Tick 3: retries, fails again, arms skip=2 (grows).
    await runWorkboardMirrorTick(
      { store: fixtureStore([card]), client, cursorStore: store },
      backoff,
    );
    expect(failingFetch).toHaveBeenCalledTimes(2);
    expect(backoff.consecutiveFailures).toBe(2);
    expect(backoff.skipTicksRemaining).toBe(2);
  });

  it("clears the backoff after a successful tick", async () => {
    const card = baseCard();
    let calls = 0;
    const fetchMock = vi.fn<typeof fetch>(async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "boom" }), { status: 503 });
      }
      return jsonResponse({ ok: true });
    });
    const client = makeClient(fetchMock);
    const store = cursorStore();
    const backoff = createMirrorBackoffState();

    await runWorkboardMirrorTick(
      { store: fixtureStore([card]), client, cursorStore: store },
      backoff,
    );
    expect(backoff.consecutiveFailures).toBe(1);
    // Skip tick.
    await runWorkboardMirrorTick(
      { store: fixtureStore([card]), client, cursorStore: store },
      backoff,
    );
    // Retry succeeds.
    const ok = await runWorkboardMirrorTick(
      { store: fixtureStore([card]), client, cursorStore: store },
      backoff,
    );
    expect(ok.failed).toBe(false);
    expect(backoff.consecutiveFailures).toBe(0);
    expect(backoff.skipTicksRemaining).toBe(0);
  });

  it("batches more than the batch size across multiple POSTs", async () => {
    const cards: WorkboardCard[] = Array.from({ length: 250 }, (_, i) =>
      baseCard({ id: `card-${i}`, title: `t-${i}` }),
    );
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);
    const store = cursorStore();
    const result = await runWorkboardMirrorTick({
      store: fixtureStore(cards),
      client,
      cursorStore: store,
    });
    expect(result.batches).toBe(2); // 200 + 50
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
    expect(first.cards.length).toBe(200);
    expect(second.cards.length).toBe(50);
  });

  it("ignores internal cards entirely in the tick (no POST, no cursor entry)", async () => {
    const internal = baseCard({ id: "secret", labels: ["internal"] });
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);
    const store = cursorStore();
    const result = await runWorkboardMirrorTick({
      store: fixtureStore([internal]),
      client,
      cursorStore: store,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.changed).toBe(0);
    expect(store.state.cards.secret).toBeUndefined();
  });
});
