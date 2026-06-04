import type {
  SkillProposalApplyResult,
  SkillProposalManifest,
  SkillProposalManifestEntry,
  SkillProposalRecord,
} from "openclaw/plugin-sdk/skill-workshop-runtime";
import { describe, expect, it, vi } from "vitest";
import { BenchSyncClient } from "./client.js";
import {
  defaultCursorState,
  loadCursor,
  type BenchSyncCursorRow,
  type BenchSyncCursorState,
  type BenchSyncCursorStore,
} from "./cursor.js";
import {
  computeProposalHash,
  projectSkillProposal,
  runDirectiveTick,
  runProposalMirrorTick,
  type PulledDirective,
  type SkillWorkshopContext,
} from "./directive-apply.js";

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

function directive(overrides: Partial<PulledDirective> = {}): PulledDirective {
  return {
    id: "dir-1",
    type: "skill_proposal_decision",
    idempotencyKey: "idem-1",
    payload: { proposalId: "prop-1", action: "apply", reason: null, decidedAt: 1 },
    ...overrides,
  };
}

function proposalRecord(overrides: Partial<SkillProposalRecord> = {}): SkillProposalRecord {
  return {
    schema: "openclaw.skill-workshop.proposal.v1",
    id: "prop-1",
    kind: "create",
    status: "pending",
    title: "Create weekly-report",
    description: "Generate the weekly report",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T01:00:00.000Z",
    createdBy: "skill-workshop",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: "h",
    target: {
      skillName: "weekly-report",
      skillKey: "weekly-report",
      skillDir: "/ws/skills/weekly-report",
      skillFile: "/ws/skills/weekly-report/SKILL.md",
    },
    scan: {
      state: "clean",
      scannedAt: "2026-06-04T00:00:00.000Z",
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    },
    ...overrides,
  };
}

function manifestEntry(
  overrides: Partial<SkillProposalManifestEntry> = {},
): SkillProposalManifestEntry {
  return {
    id: "prop-1",
    kind: "create",
    status: "pending",
    title: "Create weekly-report",
    description: "Generate the weekly report",
    skillName: "weekly-report",
    skillKey: "weekly-report",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T01:00:00.000Z",
    scanState: "clean",
    ...overrides,
  };
}

function manifest(entries: SkillProposalManifestEntry[]): SkillProposalManifest {
  return {
    schema: "openclaw.skill-workshop.proposals-manifest.v1",
    updatedAt: "2026-06-04T01:00:00.000Z",
    proposals: entries,
  };
}

function makeSkillsCtx(overrides: Partial<SkillWorkshopContext> = {}): SkillWorkshopContext {
  const applied: SkillProposalApplyResult = {
    record: proposalRecord({ status: "applied" }),
    targetSkillFile: "/ws/skills/weekly-report/SKILL.md",
  };
  return {
    workspaceDir: "/ws",
    applyProposal: vi.fn(async () => applied),
    rejectProposal: vi.fn(async () => proposalRecord({ status: "rejected" })),
    quarantineProposal: vi.fn(async () => proposalRecord({ status: "quarantined" })),
    listProposals: vi.fn(async () => manifest([])),
    inspectProposal: vi.fn(async () => ({ record: proposalRecord(), content: "# PROPOSAL" })),
    ...overrides,
  };
}

describe("runDirectiveTick — apply/reject/quarantine", () => {
  it("applies a proposal and acks 'applied'", async () => {
    const acks: Array<{ url: string; body: unknown }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/sync/directives") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ directives: [directive()], cursor: "cur-2" });
      }
      if (url.endsWith("/ack")) {
        acks.push({ url, body: JSON.parse((init!.body as string) ?? "{}") });
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: true });
    });
    const client = makeClient(fetchMock);
    const skillsCtx = makeSkillsCtx();
    const store = cursorStore();

    const result = await runDirectiveTick({ client, cursorStore: store, skillsCtx });

    expect(skillsCtx.applyProposal).toHaveBeenCalledWith({
      workspaceDir: "/ws",
      proposalId: "prop-1",
    });
    expect(result.applied).toBe(1);
    expect(acks).toHaveLength(1);
    expect(acks[0]!.body).toMatchObject({ status: "applied", result: { proposalId: "prop-1" } });
    // Directive ringed + cursor persisted.
    expect(store.state.appliedDirectiveIds).toContain("dir-1");
    expect(store.state.directiveCursor).toBe("cur-2");
    const reloaded = await loadCursor(store.store);
    expect(reloaded.directiveCursor).toBe("cur-2");
    expect(reloaded.appliedDirectiveIds).toContain("dir-1");
  });

  it("enacts a reject decision via the reject service call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/sync/directives") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          directives: [
            directive({
              id: "dir-r",
              payload: {
                proposalId: "prop-1",
                action: "reject",
                reason: "not needed",
                decidedAt: 2,
              },
            }),
          ],
        });
      }
      return jsonResponse({ ok: true });
    });
    const skillsCtx = makeSkillsCtx();
    await runDirectiveTick({
      client: makeClient(fetchMock),
      cursorStore: cursorStore(),
      skillsCtx,
    });

    expect(skillsCtx.rejectProposal).toHaveBeenCalledWith({
      workspaceDir: "/ws",
      proposalId: "prop-1",
      reason: "not needed",
    });
    expect(skillsCtx.applyProposal).not.toHaveBeenCalled();
  });

  it("enacts a quarantine decision via the quarantine service call", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/sync/directives") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({
          directives: [
            directive({
              id: "dir-q",
              payload: { proposalId: "prop-1", action: "quarantine", reason: null, decidedAt: 3 },
            }),
          ],
        });
      }
      return jsonResponse({ ok: true });
    });
    const skillsCtx = makeSkillsCtx();
    await runDirectiveTick({
      client: makeClient(fetchMock),
      cursorStore: cursorStore(),
      skillsCtx,
    });
    expect(skillsCtx.quarantineProposal).toHaveBeenCalledWith({
      workspaceDir: "/ws",
      proposalId: "prop-1",
    });
  });
});

describe("runDirectiveTick — idempotency + failure", () => {
  it("acks 'skipped' and does NOT re-enact a directive already in the ring", async () => {
    const acks: unknown[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/sync/directives") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ directives: [directive()] });
      }
      if (url.endsWith("/ack")) {
        acks.push(JSON.parse((init!.body as string) ?? "{}"));
      }
      return jsonResponse({ ok: true });
    });
    const skillsCtx = makeSkillsCtx();
    const store = cursorStore({ ...defaultCursorState(), appliedDirectiveIds: ["dir-1"] });

    const result = await runDirectiveTick({
      client: makeClient(fetchMock),
      cursorStore: store,
      skillsCtx,
    });

    expect(skillsCtx.applyProposal).not.toHaveBeenCalled();
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
    expect(acks).toEqual([{ status: "skipped", reason: "already applied" }]);
  });

  it("acks 'failed' on a service error and STILL rings the id (no infinite retry)", async () => {
    const acks: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/sync/directives") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ directives: [directive()] });
      }
      if (url.endsWith("/ack")) {
        acks.push(JSON.parse((init!.body as string) ?? "{}"));
      }
      return jsonResponse({ ok: true });
    });
    const skillsCtx = makeSkillsCtx({
      applyProposal: vi.fn(async () => {
        throw new Error("Proposal scan failed; proposal was quarantined.");
      }),
    });
    const store = cursorStore();

    const result = await runDirectiveTick({
      client: makeClient(fetchMock),
      cursorStore: store,
      skillsCtx,
    });

    expect(result.failed).toBe(1);
    expect(acks[0]).toMatchObject({ status: "failed" });
    expect((acks[0]!.error as { message: string }).message).toContain("scan failed");
    // Ringed despite failure → not retried next tick.
    expect(store.state.appliedDirectiveIds).toContain("dir-1");
  });

  it("does not leak secrets in the failed ack error", async () => {
    const acks: Array<Record<string, unknown>> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/sync/directives") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ directives: [directive()] });
      }
      if (url.endsWith("/ack")) {
        acks.push(JSON.parse((init!.body as string) ?? "{}"));
      }
      return jsonResponse({ ok: true });
    });
    const skillsCtx = makeSkillsCtx({
      applyProposal: vi.fn(async () => {
        throw new Error("workspace failure");
      }),
    });
    await runDirectiveTick({
      client: makeClient(fetchMock),
      cursorStore: cursorStore(),
      skillsCtx,
    });
    const err = acks[0]!.error as { code: string; message: string };
    expect(err.code).toBe("apply_failed");
    expect(err.message).toBe("workspace failure");
  });

  it("persists the directive cursor from the response", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/sync/directives") && (init?.method ?? "GET") === "GET") {
        return jsonResponse({ directives: [], cursor: "next-cursor" });
      }
      return jsonResponse({ ok: true });
    });
    const store = cursorStore();
    await runDirectiveTick({
      client: makeClient(fetchMock),
      cursorStore: store,
      skillsCtx: makeSkillsCtx(),
    });
    expect(store.state.directiveCursor).toBe("next-cursor");
    expect((await loadCursor(store.store)).directiveCursor).toBe("next-cursor");
  });
});

describe("projectSkillProposal", () => {
  it("maps the record to the cloud mirror payload (support files = metadata only)", () => {
    const record = proposalRecord({
      kind: "update",
      status: "pending",
      origin: { agentId: "cole" },
      target: {
        skillName: "weekly-report",
        skillKey: "weekly-report",
        skillDir: "/ws/skills/weekly-report",
        skillFile: "/ws/skills/weekly-report/SKILL.md",
        currentContentHash: "abc",
      },
      supportFiles: [{ path: "templates/w.md", sizeBytes: 12, hash: "deadbeef" }],
    });
    const projected = projectSkillProposal(record, "# PROPOSAL body");
    expect(projected).toMatchObject({
      proposalId: "prop-1",
      name: "weekly-report",
      status: "pending",
      kind: "update",
      targetSkillRef: "/ws/skills/weekly-report/SKILL.md",
      targetHash: "abc",
      proposalMarkdown: "# PROPOSAL body",
      createdByActor: "cole",
      supportFiles: [{ path: "templates/w.md", folder: "templates", bytes: 12, hash: "deadbeef" }],
    });
    // The support-file content must never appear — only metadata.
    expect(JSON.stringify(projected)).not.toContain("body of template");
  });

  it("maps workshop scanner states into the cloud scanner enum", () => {
    expect(
      projectSkillProposal(
        proposalRecord({
          scan: {
            state: "clean",
            scannedAt: "2026-06-04T00:00:00.000Z",
            critical: 0,
            warn: 1,
            info: 0,
            findings: [{ ruleId: "WARN", severity: "warn", message: "review this" }],
          },
        }),
        "# PROPOSAL",
      ).scanner.status,
    ).toBe("flagged");
    expect(
      projectSkillProposal(
        proposalRecord({
          scan: {
            state: "quarantined",
            scannedAt: "2026-06-04T00:00:00.000Z",
            critical: 1,
            warn: 0,
            info: 0,
            findings: [{ ruleId: "CRIT", severity: "critical", message: "unsafe" }],
          },
        }),
        "# PROPOSAL",
      ).scanner.status,
    ).toBe("failed");
  });
});

describe("runProposalMirrorTick", () => {
  it("mirrors a pending proposal once when mirrorPendingUp is true (hash-dedupes after)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);
    const skillsCtx = makeSkillsCtx({
      listProposals: vi.fn(async () => manifest([manifestEntry()])),
    });
    const store = cursorStore();

    const first = await runProposalMirrorTick({
      client,
      cursorStore: store,
      skillsCtx,
      mirrorPendingUp: true,
    });
    expect(first.changed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second tick: unchanged → hash dedupe → no POST.
    const second = await runProposalMirrorTick({
      client,
      cursorStore: store,
      skillsCtx,
      mirrorPendingUp: true,
    });
    expect(second.changed).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("suppresses pending proposals when mirrorPendingUp is false", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const skillsCtx = makeSkillsCtx({
      listProposals: vi.fn(async () => manifest([manifestEntry({ status: "pending" })])),
    });
    const result = await runProposalMirrorTick({
      client: makeClient(fetchMock),
      cursorStore: cursorStore(),
      skillsCtx,
      mirrorPendingUp: false,
    });
    expect(result.considered).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("mirrors a STATUS CHANGE even when mirrorPendingUp is false", async () => {
    let posted: unknown;
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/skill-proposals/sync")) {
        posted = JSON.parse((init!.body as string) ?? "{}");
      }
      return jsonResponse({ ok: true });
    });
    const skillsCtx = makeSkillsCtx({
      listProposals: vi.fn(async () =>
        manifest([manifestEntry({ id: "prop-1", status: "applied" })]),
      ),
      inspectProposal: vi.fn(async () => ({
        record: proposalRecord({ status: "applied" }),
        content: "# PROPOSAL",
      })),
    });
    const result = await runProposalMirrorTick({
      client: makeClient(fetchMock),
      cursorStore: cursorStore(),
      skillsCtx,
      mirrorPendingUp: false,
    });
    expect(result.changed).toBe(1);
    expect((posted as { proposals: unknown[] }).proposals).toHaveLength(1);
    expect((posted as { proposals: Array<{ status: string }> }).proposals[0].status).toBe(
      "applied",
    );
  });

  it("never includes support-file bytes in the mirror payload", async () => {
    let posted = "";
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/skill-proposals/sync")) {
        posted = (init!.body as string) ?? "";
      }
      return jsonResponse({ ok: true });
    });
    const skillsCtx = makeSkillsCtx({
      listProposals: vi.fn(async () => manifest([manifestEntry()])),
      inspectProposal: vi.fn(async () => ({
        record: proposalRecord({
          supportFiles: [{ path: "scripts/run.sh", sizeBytes: 99, hash: "h99" }],
        }),
        // The PROPOSAL.md body is allowed; support-file *contents* are not even
        // available to the mirror (only metadata is read).
        content: "# PROPOSAL",
      })),
    });
    await runProposalMirrorTick({
      client: makeClient(fetchMock),
      cursorStore: cursorStore(),
      skillsCtx,
      mirrorPendingUp: true,
    });
    expect(posted).toContain("scripts/run.sh");
    expect(posted).toContain("\"folder\":\"scripts\"");
    expect(posted).toContain("h99");
    expect(posted).not.toContain("SECRET_SCRIPT_CONTENT");
  });

  it("re-mirrors when a proposal's status changes (hash differs)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);
    let status: SkillProposalManifestEntry["status"] = "pending";
    const skillsCtx = makeSkillsCtx({
      listProposals: vi.fn(async () => manifest([manifestEntry({ status })])),
      inspectProposal: vi.fn(async () => ({
        record: proposalRecord({ status }),
        content: "# PROPOSAL",
      })),
    });
    const store = cursorStore();

    await runProposalMirrorTick({ client, cursorStore: store, skillsCtx, mirrorPendingUp: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Status flips to applied — same id, new hash → re-mirror.
    status = "applied";
    const result = await runProposalMirrorTick({
      client,
      cursorStore: store,
      skillsCtx,
      mirrorPendingUp: true,
    });
    expect(result.changed).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("computeProposalHash", () => {
  it("is stable regardless of key order", () => {
    const record = proposalRecord();
    const a = projectSkillProposal(record, "# x");
    const b = projectSkillProposal(record, "# x");
    expect(computeProposalHash(a)).toBe(computeProposalHash(b));
  });
});
