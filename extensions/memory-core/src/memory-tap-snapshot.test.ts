// Memory Tap tests cover request bounds, private evidence handling, and healthy empty windows.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { appendNarrativeEntry } from "./dreaming-narrative.js";
import {
  MemoryTapInvalidRequestError,
  normalizeMemoryTapSnapshotParams,
} from "./memory-tap-contract.js";
import { buildMemoryTapSnapshot, inspectMemoryTapSearchHealth } from "./memory-tap-snapshot.js";
import {
  readShortTermRecallEntries,
  recordDreamingPhaseSignals,
  recordShortTermRecalls,
  testing as shortTermTesting,
} from "./short-term-promotion.js";
import { createMemoryCoreTestHarness } from "./test-helpers.js";

const { createTempWorkspace } = createMemoryCoreTestHarness();

function dreamingConfig(workspaceDir: string, storageMode: "inline" | "separate" = "separate") {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
      },
    },
    plugins: {
      entries: {
        "memory-core": {
          enabled: true,
          config: {
            dreaming: {
              enabled: true,
              storage: { mode: storageMode },
            },
          },
        },
      },
    },
  } as OpenClawConfig;
}

async function setFileMtime(filePath: string, epochMs: number): Promise<void> {
  const time = new Date(epochMs);
  await fs.utimes(filePath, time, time);
}

describe("normalizeMemoryTapSnapshotParams", () => {
  it("defaults to a bounded 24-hour window and clamps output limits", () => {
    const nowMs = Date.parse("2026-07-12T03:30:00.000Z");
    expect(
      normalizeMemoryTapSnapshotParams({ maxCandidates: 5_000, maxQuoteChars: 1 }, nowMs),
    ).toEqual({
      since: "2026-07-11T03:30:00.000Z",
      until: "2026-07-12T03:30:00.000Z",
      kinds: ["dream", "memory", "session"],
      maxCandidates: 25,
      maxQuoteChars: 40,
    });
  });

  it("rejects ambiguous, inverted, overlong, and unsupported requests", () => {
    for (const params of [null, "window", []]) {
      expect(() => normalizeMemoryTapSnapshotParams(params)).toThrow("params must be an object");
    }
    expect(() => normalizeMemoryTapSnapshotParams({ since: "2026-07-11" }, 0)).toThrow(
      MemoryTapInvalidRequestError,
    );
    expect(() =>
      normalizeMemoryTapSnapshotParams({
        since: "2026-07-12T04:00:00Z",
        until: "2026-07-12T03:00:00Z",
      }),
    ).toThrow("since must be earlier than until");
    expect(() =>
      normalizeMemoryTapSnapshotParams({
        since: "2026-07-09T03:00:00Z",
        until: "2026-07-12T03:00:00Z",
      }),
    ).toThrow("cannot exceed 48 hours");
    expect(() => normalizeMemoryTapSnapshotParams({ transcript: true })).toThrow(
      "params contain an unsupported field",
    );
    expect(() => normalizeMemoryTapSnapshotParams({ kinds: [] })).toThrow(
      "kinds must contain 1 to 3 supported values",
    );
    expect(() => normalizeMemoryTapSnapshotParams({ kinds: ["dream", "transcript"] })).toThrow(
      "kinds contains an unsupported value",
    );
    expect(() =>
      normalizeMemoryTapSnapshotParams(
        { until: "2026-07-12T03:30:00.001Z" },
        Date.parse("2026-07-12T03:30:00.000Z"),
      ),
    ).toThrow("until cannot be later than the snapshot time");
  });
});

describe("buildMemoryTapSnapshot", () => {
  it("reports usable full-text-only search as degraded instead of failed", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-fts-only-");
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({}, nowMs),
      nowMs,
      searchHealth: { status: "warn", detail: "full-text-only search configured" },
    });

    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.health.checks).toContainEqual({
      id: "memory",
      status: "warn",
      detail: "readable; memory=0; sessions=0; full-text-only search configured",
    });
  });

  it("returns deterministic bounded evidence without paths, transcript rows, or secrets", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-evidence-");
    const observedMs = Date.parse("2026-07-12T03:30:00.000Z");
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    const window = normalizeMemoryTapSnapshotParams(
      {
        since: "2026-07-12T02:00:00.000Z",
        until: "2026-07-12T04:00:00.000Z",
        maxCandidates: 10,
        maxQuoteChars: 120,
      },
      nowMs,
    );
    const memoryDir = path.join(workspaceDir, "memory");
    const dailyPath = path.join(memoryDir, "2026-07-12.md");
    const memorySnippet =
      `Synthetic warranty claims need explicit lifecycle dates and inventory batch provenance. ${"Fictional warehouse context stays reviewable. ".repeat(6)}`.trim();
    await fs.mkdir(path.join(memoryDir, "dreaming", "rem"), { recursive: true });
    await fs.writeFile(dailyPath, `${memorySnippet}\n`, "utf-8");
    const reportPath = path.join(memoryDir, "dreaming", "rem", "2026-07-12.md");
    await fs.writeFile(reportPath, "# REM Sleep\n\nA bounded report.\n", "utf-8");
    await setFileMtime(reportPath, observedMs);
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "A warranty card drifted between two imaginary warehouse shelves.",
      nowMs: observedMs,
      timezone: "UTC",
    });
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "A warranty card drifted between two imaginary warehouse shelves.",
      nowMs: observedMs,
      timezone: "UTC",
    });
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "Write a dream diary entry from these memory fragments: managed prompt text.",
      nowMs: observedMs,
      timezone: "UTC",
    });
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "memoryTapRuns internal receipt should never become dream evidence.",
      nowMs: observedMs,
      timezone: "UTC",
    });
    await setFileMtime(path.join(workspaceDir, "DREAMS.md"), observedMs);

    await recordShortTermRecalls({
      workspaceDir,
      query: "review synthetic warranty inventory",
      nowMs: observedMs,
      results: [
        {
          path: "memory/2026-07-12.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: memorySnippet,
          source: "memory",
        },
        {
          path: "memory/2026-07-12-private.md",
          startLine: 1,
          endLine: 1,
          score: 0.95,
          snippet: "OPENAI_API_KEY=sk-1234567890abcdef", // pragma: allowlist secret
          source: "memory",
        },
        {
          path: "memory/2026-07-12-forge.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: "forgePackets internal projection should not become memory evidence.",
          source: "memory",
        },
        {
          path: "memory/.dreams/session-corpus/2026-07-12.txt",
          startLine: 8,
          endLine: 8,
          score: 0.8,
          snippet: "A raw conversation row that must never leave the gateway.",
          source: "memory",
        },
        {
          path: "memory/.dreams/session-corpus/2026-07-12.txt",
          startLine: 9,
          endLine: 9,
          score: 0.85,
          snippet: "TOKEN=abcdef1234567890ghij", // pragma: allowlist secret
          source: "memory",
        },
        {
          path: "memory/.dreams/session-corpus/2026-07-12.txt",
          startLine: 10,
          endLine: 10,
          score: 0.85,
          snippet: "dreaming-narrative internal row should not ship",
          source: "memory",
        },
        {
          path: "memory/.dreams/session-corpus/2026-07-12.txt",
          startLine: 11,
          endLine: 11,
          score: 0.85,
          snippet: "memory-tap internal carrier row should not ship",
          source: "memory",
        },
      ],
    });
    const safeSessionEntry = (await readShortTermRecallEntries({ workspaceDir, nowMs })).find(
      (entry) => entry.path.includes("session-corpus") && entry.startLine === 8,
    );
    if (!safeSessionEntry) {
      throw new Error("safe session evidence was not recorded");
    }
    await recordDreamingPhaseSignals({
      workspaceDir,
      phase: "light",
      keys: [safeSessionEntry.key],
      nowMs,
    });
    await recordDreamingPhaseSignals({
      workspaceDir,
      phase: "rem",
      keys: [safeSessionEntry.key],
      nowMs,
    });

    const input = {
      cfg: dreamingConfig(workspaceDir),
      agentId: "main",
      workspaceDir,
      request: window,
      nowMs,
    };
    const first = await buildMemoryTapSnapshot(input);
    const second = await buildMemoryTapSnapshot(input);

    expect(second).toEqual(first);
    expect(first.schemaVersion).toBe(1);
    expect(first.health.ok).toBe(true);
    expect(first.candidates.map((candidate) => candidate.kind)).toEqual([
      "dream",
      "session",
      "memory",
    ]);
    const dreamCandidate = first.candidates.find((candidate) => candidate.kind === "dream");
    expect(dreamCandidate?.provenance.ref).toMatch(/^dreams:\/\/diary\/[a-f0-9]{64}$/);
    expect(dreamCandidate?.provenance.ref).toBe(
      `dreams://diary/${dreamCandidate?.provenance.digest}`,
    );
    const sessionCandidate = first.candidates.find((candidate) => candidate.kind === "session");
    expect(sessionCandidate).toMatchObject({
      excerpt: "Indexed session evidence (1).",
      signals: { recallCount: 1, phaseHitCount: 2 },
      provenance: { ref: "sessions://indexed/2026-07-12" },
    });
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain(workspaceDir);
    expect(serialized).not.toContain("A raw conversation row");
    expect(serialized).not.toContain("managed prompt text");
    expect(serialized).not.toContain("memoryTapRuns internal receipt");
    expect(serialized).not.toContain("forgePackets internal projection");
    expect(serialized).not.toContain("dreaming-narrative internal row");
    expect(serialized).not.toContain("memory-tap internal carrier row");
    expect(serialized).not.toContain("sk-1234567890abcdef"); // pragma: allowlist secret
    expect(serialized).not.toContain("abcdef1234567890ghij"); // pragma: allowlist secret
    expect(serialized).not.toContain(".jsonl");
    expect(first.provenance.filteredSecretCount).toBe(2);
    expect(first.provenance.examined).toBe(11);
    expect(first.health.checks).toContainEqual({
      id: "secrets",
      status: "warn",
      detail: "filtered=2",
    });
    expect(first.health.checks).toContainEqual({
      id: "self-ingestion",
      status: "warn",
      detail: "filtered=5",
    });
    expect(first.health.checks).toContainEqual({
      id: "memory",
      status: "ok",
      detail: "readable; memory=1; sessions=1",
    });
    expect(first.health.ok).toBe(true);
    const memoryCandidate = first.candidates.find((candidate) => candidate.kind === "memory");
    expect(memoryCandidate?.excerpt).toHaveLength(120);
    expect(memoryCandidate?.excerpt.endsWith("…")).toBe(true);
    expect(first.candidates.every((candidate) => candidate.excerpt.length <= 120)).toBe(true);

    const minimumQuote = await buildMemoryTapSnapshot({
      ...input,
      request: { ...window, maxQuoteChars: 40 },
    });
    expect(minimumQuote.provenance.quoteLimit).toBe(40);
    expect(minimumQuote.candidates.every((candidate) => candidate.excerpt.length <= 40)).toBe(true);

    const laterMs = Date.parse("2026-07-12T03:45:00.000Z");
    await recordShortTermRecalls({
      workspaceDir,
      query: "review synthetic warranty inventory again",
      nowMs: laterMs,
      results: [
        {
          path: "memory/2026-07-12.md",
          startLine: 1,
          endLine: 1,
          score: 0.9,
          snippet: memorySnippet,
          source: "memory",
        },
        {
          path: "memory/.dreams/session-corpus/2026-07-12.txt",
          startLine: 8,
          endLine: 8,
          score: 0.8,
          snippet: "A raw conversation row that must never leave the gateway.",
          source: "memory",
        },
      ],
    });
    const matured = await buildMemoryTapSnapshot(input);
    const maturedSession = matured.candidates.find((candidate) => candidate.kind === "session");
    const maturedMemory = matured.candidates.find((candidate) => candidate.kind === "memory");
    expect(maturedSession).toMatchObject({
      id: sessionCandidate?.id,
      provenance: { digest: sessionCandidate?.provenance.digest },
      signals: { recallCount: 2, phaseHitCount: 2 },
    });
    expect(maturedMemory).toMatchObject({
      id: memoryCandidate?.id,
      provenance: { digest: memoryCandidate?.provenance.digest },
      signals: { recallCount: 2 },
    });
    expect(maturedSession?.observedAt).not.toBe(sessionCandidate?.observedAt);
    expect(maturedMemory?.observedAt).not.toBe(memoryCandidate?.observedAt);

    const limited = await buildMemoryTapSnapshot({
      ...input,
      request: { ...window, maxCandidates: 2 },
    });
    expect(limited.candidates).toHaveLength(2);
    expect(limited.provenance.truncated).toBe(true);

    const dreamOnly = await buildMemoryTapSnapshot({
      ...input,
      request: { ...window, kinds: ["dream"] },
    });
    expect(dreamOnly.candidates.map((candidate) => candidate.kind)).toEqual(["dream"]);
    expect(JSON.stringify(dreamOnly)).not.toMatch(/(?:memory|sessions):\/\//);
    expect(dreamOnly.provenance.filteredSecretCount).toBe(0);
    expect(dreamOnly.provenance.examined).toBe(4);
    expect(dreamOnly.health.checks).toContainEqual({
      id: "memory",
      status: "ok",
      detail: "readable; memory=0; sessions=0",
    });
  });

  it("treats a fresh quiet night with zero eligible evidence as fully healthy", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-empty-");
    const nowMs = Date.parse("2026-07-12T03:30:00.000Z");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    await setFileMtime(dreamsPath, nowMs - 1_000);
    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({}, nowMs),
      nowMs,
    });

    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.health.checks.every((check) => check.status === "ok")).toBe(true);
    expect(snapshot.health.checks).toContainEqual({
      id: "memory",
      status: "ok",
      detail: "readable; memory=0; sessions=0",
    });
    expect(snapshot.health.checks).toContainEqual({
      id: "cron",
      status: "ok",
      detail: "fresh dream artifact observed",
    });
  });

  it("warns about a missing dream artifact without failing an otherwise quiet window", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-missing-dream-");
    const nowMs = Date.parse("2026-07-12T03:30:00.000Z");
    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({}, nowMs),
      nowMs,
    });

    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.health.checks).toContainEqual({
      id: "cron",
      status: "warn",
      detail: "no fresh dream artifact observed",
    });
  });

  it("keeps the newest in-window diary entries without making old dreams fresh", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-diary-window-");
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    for (const [timestamp, narrative] of [
      ["2026-07-10T03:00:00.000Z", "Old warranty dream outside the requested window."],
      ["2026-07-12T02:15:00.000Z", "First in-window synthetic warranty observation."],
      ["2026-07-12T02:45:00.000Z", "Second in-window synthetic warranty observation."],
      ["2026-07-12T03:15:00.000Z", "Newest in-window synthetic warranty observation."],
    ] as const) {
      await appendNarrativeEntry({
        workspaceDir,
        narrative,
        nowMs: Date.parse(timestamp),
        timezone: "UTC",
      });
    }
    await setFileMtime(
      path.join(workspaceDir, "DREAMS.md"),
      Date.parse("2026-07-12T03:30:00.000Z"),
    );

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams(
        {
          since: "2026-07-12T02:00:00.000Z",
          until: "2026-07-12T04:00:00.000Z",
          kinds: ["dream"],
          maxCandidates: 2,
        },
        nowMs,
      ),
      nowMs,
    });

    expect(snapshot.candidates.map((candidate) => candidate.excerpt)).toEqual([
      "Newest in-window synthetic warranty observation.",
      "Second in-window synthetic warranty observation.",
    ]);
    expect(snapshot.provenance.examined).toBe(3);
    expect(snapshot.provenance.truncated).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("Old warranty dream");
  });

  it("parses embedded diary timestamps even when the diary was edited after the requested window", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-diary-past-window-");
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "A synthetic warranty note belongs to the earlier window.",
      nowMs: Date.parse("2026-07-12T02:30:00.000Z"),
      timezone: "UTC",
    });
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "A later synthetic warranty note belongs outside the requested window.",
      nowMs: Date.parse("2026-07-12T03:30:00.000Z"),
      timezone: "UTC",
    });
    await setFileMtime(path.join(workspaceDir, "DREAMS.md"), nowMs - 30_000);

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams(
        {
          since: "2026-07-12T02:00:00.000Z",
          until: "2026-07-12T03:00:00.000Z",
          kinds: ["dream"],
        },
        nowMs,
      ),
      nowMs,
    });

    expect(snapshot.candidates.map((candidate) => candidate.excerpt)).toEqual([
      "A synthetic warranty note belongs to the earlier window.",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("later synthetic warranty note");
    expect(snapshot.health.checks).toContainEqual({
      id: "dreaming",
      status: "warn",
      detail:
        "enabled; diary=present but outside requested window; reports=not required by storage mode",
    });
  });

  it("includes a legacy minute-precision dream that overlaps a second-precision window", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-legacy-diary-time-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "",
        "---",
        "",
        "*July 12, 2026 at 3:30 AM UTC*",
        "",
        "A legacy synthetic warranty observation crossed the minute boundary.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    await setFileMtime(dreamsPath, Date.parse("2026-07-12T03:31:00.000Z"));
    const since = "2026-07-12T03:30:25.000Z";
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams(
        { since, until: "2026-07-12T04:00:00.000Z", kinds: ["dream"] },
        nowMs,
      ),
      nowMs,
    });

    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.candidates[0]?.observedAt).toBe(since);
  });

  it("ignores a machine timestamp marker embedded in legacy narrative text", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-diary-marker-spoof-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      [
        "# Dream Diary",
        "",
        "<!-- openclaw:dreaming:diary:start -->",
        "",
        "---",
        "",
        "*July 10, 2026 at 3:30 AM UTC*",
        "",
        "A legacy narrative quoted <!-- openclaw:dreaming:observed-at:2026-07-12T03:45:00.000Z --> inline.",
        "",
        "<!-- openclaw:dreaming:diary:end -->",
        "",
      ].join("\n"),
      "utf-8",
    );
    await setFileMtime(dreamsPath, Date.parse("2026-07-12T03:50:00.000Z"));
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams(
        {
          since: "2026-07-12T03:00:00.000Z",
          until: "2026-07-12T04:00:00.000Z",
          kinds: ["dream"],
        },
        nowMs,
      ),
      nowMs,
    });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.provenance.examined).toBe(0);
  });

  it.skipIf(process.platform === "win32")(
    "reports a fresh but unreadable diary as unhealthy instead of quiet",
    async () => {
      const workspaceDir = await createTempWorkspace("memory-tap-unreadable-diary-");
      const dreamsPath = path.join(workspaceDir, "DREAMS.md");
      const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
      await fs.writeFile(
        dreamsPath,
        "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n<!-- openclaw:dreaming:diary:end -->\n",
        "utf-8",
      );
      await setFileMtime(dreamsPath, nowMs - 1_000);
      await fs.chmod(dreamsPath, 0o000);
      try {
        const snapshot = await buildMemoryTapSnapshot({
          cfg: dreamingConfig(workspaceDir, "inline"),
          agentId: "main",
          workspaceDir,
          request: normalizeMemoryTapSnapshotParams({ kinds: ["dream"] }, nowMs),
          nowMs,
        });
        expect(snapshot.health.ok).toBe(false);
        expect(snapshot.candidates).toEqual([]);
        expect(snapshot.health.checks).toContainEqual({
          id: "dreaming",
          status: "error",
          detail: "enabled; diary=unreadable; reports=not required by storage mode",
        });
        expect(snapshot.health.checks).toContainEqual({
          id: "cron",
          status: "error",
          detail: "no fresh dream artifact observed",
        });
      } finally {
        await fs.chmod(dreamsPath, 0o600);
      }
    },
  );

  it("reports a fresh malformed diary as unhealthy instead of quiet", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-malformed-diary-");
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    await fs.writeFile(dreamsPath, "# Dream Diary\n\nmanaged markers were lost\n", "utf-8");
    await setFileMtime(dreamsPath, nowMs - 1_000);

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({ kinds: ["dream"] }, nowMs),
      nowMs,
    });

    expect(snapshot.health.ok).toBe(false);
    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.health.checks).toContainEqual({
      id: "dreaming",
      status: "error",
      detail: "enabled; diary=unreadable; reports=not required by storage mode",
    });

    const memoryOnly = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({ kinds: ["memory"] }, nowMs),
      nowMs,
    });
    expect(memoryOnly.health.ok).toBe(false);
    expect(memoryOnly.health.checks).toContainEqual({
      id: "dreaming",
      status: "error",
      detail: "enabled; diary=unreadable; reports=not required by storage mode",
    });
  });

  it("warns when a configured separate dream report is missing despite a fresh diary", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-missing-report-");
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    await appendNarrativeEntry({
      workspaceDir,
      narrative: "A fresh synthetic warranty observation.",
      nowMs: nowMs - 60_000,
      timezone: "UTC",
    });
    await setFileMtime(path.join(workspaceDir, "DREAMS.md"), nowMs - 60_000);

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "separate"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({ kinds: ["dream"] }, nowMs),
      nowMs,
    });

    expect(snapshot.health.ok).toBe(true);
    expect(snapshot.health.checks).toContainEqual({
      id: "dreaming",
      status: "warn",
      detail: "enabled; diary=fresh; entries=1; reports=not present",
    });
    expect(snapshot.health.checks).toContainEqual({
      id: "cron",
      status: "ok",
      detail: "fresh dream artifact observed",
    });
  });

  it("scans past a filtered diary prefix to fill the bounded safe result", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-filtered-prefix-");
    const nowMs = Date.parse("2026-07-12T04:00:00.000Z");
    for (const [offset, narrative] of [
      [180_000, "A safe fictional warranty workflow needs a clearer state."],
      [120_000, "memoryTapRuns recursive evidence must be filtered."],
      [60_000, "forgePackets recursive evidence must be filtered."],
    ] as const) {
      await appendNarrativeEntry({
        workspaceDir,
        narrative,
        nowMs: nowMs - offset,
        timezone: "UTC",
      });
    }
    await setFileMtime(path.join(workspaceDir, "DREAMS.md"), nowMs - 30_000);

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({ kinds: ["dream"], maxCandidates: 1 }, nowMs),
      nowMs,
    });

    expect(snapshot.candidates.map((candidate) => candidate.excerpt)).toEqual([
      "A safe fictional warranty workflow needs a clearer state.",
    ]);
    expect(snapshot.provenance.examined).toBe(3);
    expect(snapshot.health.checks).toContainEqual({
      id: "self-ingestion",
      status: "warn",
      detail: "filtered=2",
    });
  });

  it("clamps legacy signal counters and normalizes ascending positive memory lines", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-legacy-bounds-");
    const nowMs = Date.parse("2026-07-12T03:30:00.000Z");
    const observedAt = new Date(nowMs - 5_000).toISOString();
    const dreamsPath = path.join(workspaceDir, "DREAMS.md");
    await fs.writeFile(
      dreamsPath,
      "# Dream Diary\n\n<!-- openclaw:dreaming:diary:start -->\n<!-- openclaw:dreaming:diary:end -->\n",
      "utf-8",
    );
    await setFileMtime(dreamsPath, nowMs - 1_000);
    const rawEntry = (params: {
      key: string;
      path: string;
      startLine: number;
      endLine: number;
      snippet: string;
      count: number;
    }) => ({
      key: params.key,
      path: params.path,
      startLine: params.startLine,
      endLine: params.endLine,
      source: "memory",
      snippet: params.snippet,
      recallCount: params.count,
      dailyCount: params.count,
      groundedCount: params.count,
      totalScore: params.count,
      maxScore: 1,
      firstRecalledAt: observedAt,
      lastRecalledAt: observedAt,
      queryHashes: [],
      recallDays: ["2026-07-12"],
      conceptTags: [],
    });
    await shortTermTesting.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: observedAt,
      entries: {
        "legacy-memory": rawEntry({
          key: "legacy-memory",
          path: "memory/2026-07-12.md",
          startLine: 1e21,
          endLine: 2,
          snippet: "Legacy memory evidence with a reversed line range.",
          count: 25_000,
        }),
        "session-a": rawEntry({
          key: "session-a",
          path: "memory/.dreams/session-corpus/2026-07-12.txt",
          startLine: 1,
          endLine: 1,
          snippet: "First safe indexed session observation.",
          count: 8_000,
        }),
        "session-b": rawEntry({
          key: "session-b",
          path: "memory/.dreams/session-corpus/2026-07-12.txt",
          startLine: 2,
          endLine: 2,
          snippet: "Second safe indexed session observation.",
          count: 8_000,
        }),
      },
    });
    await shortTermTesting.writeRawPhaseSignalStore(workspaceDir, {
      version: 1,
      updatedAt: observedAt,
      entries: {
        "legacy-memory": { key: "legacy-memory", lightHits: 9_000, remHits: 9_000 },
        "session-a": { key: "session-a", lightHits: 8_000, remHits: 0 },
        "session-b": { key: "session-b", lightHits: 8_000, remHits: 0 },
      },
    });

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({ kinds: ["memory", "session"] }, nowMs),
      nowMs,
    });
    const memory = snapshot.candidates.find((candidate) => candidate.kind === "memory");
    const session = snapshot.candidates.find((candidate) => candidate.kind === "session");
    expect(memory?.provenance.ref).toBe(
      "memory://daily/2026-07-12#L9007199254740991-L9007199254740991",
    );
    expect(memory?.signals).toEqual({
      recallCount: 10_000,
      dailyCount: 10_000,
      groundedCount: 10_000,
      phaseHitCount: 10_000,
    });
    expect(session?.signals).toEqual({
      recallCount: 10_000,
      dailyCount: 10_000,
      groundedCount: 10_000,
      phaseHitCount: 10_000,
    });
    expect(snapshot.provenance.examined).toBe(3);
  });

  it("hard-drops evidence matched by configured logging redaction patterns", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-custom-redaction-");
    const nowMs = Date.parse("2026-07-12T03:30:00.000Z");
    const observedAt = new Date(nowMs - 5_000).toISOString();
    const configPath = path.join(workspaceDir, "custom-redaction.json");
    await fs.writeFile(
      configPath,
      JSON.stringify({ logging: { redactPatterns: ["/CUSTOMSECRET-[A-Z0-9]+/g"] } }),
      "utf-8",
    );
    await shortTermTesting.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: observedAt,
      entries: {
        "custom-secret": {
          key: "custom-secret",
          path: "memory/2026-07-12.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "Synthetic warranty note CUSTOMSECRET-ALPHA must stay local.",
          recallCount: 1,
          dailyCount: 1,
          groundedCount: 1,
          totalScore: 1,
          maxScore: 1,
          firstRecalledAt: observedAt,
          lastRecalledAt: observedAt,
          queryHashes: [],
          recallDays: ["2026-07-12"],
          conceptTags: [],
        },
      },
    });

    const snapshot = await withEnvAsync(
      { OPENCLAW_CONFIG_PATH: configPath },
      async () =>
        await buildMemoryTapSnapshot({
          cfg: dreamingConfig(workspaceDir, "inline"),
          agentId: "main",
          workspaceDir,
          request: normalizeMemoryTapSnapshotParams({ kinds: ["memory"] }, nowMs),
          nowMs,
        }),
    );

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.provenance.filteredSecretCount).toBe(1);
    expect(snapshot.health.checks).toContainEqual({
      id: "secrets",
      status: "warn",
      detail: "filtered=1",
    });
    expect(JSON.stringify(snapshot)).not.toContain("CUSTOMSECRET-ALPHA");
  });

  it("hard-drops absolute paths and raw identity markers before export", async () => {
    const workspaceDir = await createTempWorkspace("memory-tap-raw-evidence-");
    const nowMs = Date.parse("2026-07-12T03:30:00.000Z");
    const observedAt = new Date(nowMs - 5_000).toISOString();
    const unsafeSnippets = [
      "/Users/example/private/session.json",
      "/home/example/private/session.json",
      "/private/var/folders/example/session.json",
      "/var/log/example.log",
      "/opt/example/session.json",
      "/etc/example/config.json",
      "/root/.openclaw/sessions/example.json",
      "/tmp/openclaw/example.json",
      "/srv/openclaw/example.json",
      "/Volumes/Customer Data/example.json",
      "~/private/session.json",
      "file:///tmp/private/session.json",
      "C:\\Users\\example\\session.json",
      "C:/Users/example/session.json",
      "\\\\server\\share\\session.json",
      "//server/share/session.json",
      "workspace:/root/.openclaw/sessions/example.json",
      "cwd:/srv/openclaw/example.json",
      "workspace:\\\\server\\share\\session.json",
      "rawTranscript=private-row",
      "raw_session=private-row",
      "sessionId=private-session",
      "session_marker=private-session",
      "sessionKey=agent:main:discord:channel:synthetic",
      "session_key=agent:main:slack:channel:synthetic",
      "session-key=agent:main:web:synthetic",
      "sessionFile=main.jsonl",
      "session_path=sessions/main.jsonl",
      "sessionFiles=[main.jsonl]",
      "sessionKeys=[agent:main:web:synthetic]",
      "rawSessions=[synthetic-session]",
      "tenantId=private-tenant",
      "instanceId=private-instance",
      "customerId=private-customer",
      "absolutePath=private-path",
    ];
    await shortTermTesting.writeRawRecallStore(workspaceDir, {
      version: 1,
      updatedAt: observedAt,
      entries: Object.fromEntries(
        unsafeSnippets.map((snippet, index) => [
          `unsafe-${index}`,
          {
            key: `unsafe-${index}`,
            path: "memory/2026-07-12.md",
            startLine: index + 1,
            endLine: index + 1,
            source: "memory",
            snippet,
            recallCount: 1,
            dailyCount: 1,
            groundedCount: 1,
            totalScore: 1,
            maxScore: 1,
            firstRecalledAt: observedAt,
            lastRecalledAt: observedAt,
            queryHashes: [],
            recallDays: ["2026-07-12"],
            conceptTags: [],
          },
        ]),
      ),
    });

    const snapshot = await buildMemoryTapSnapshot({
      cfg: dreamingConfig(workspaceDir, "inline"),
      agentId: "main",
      workspaceDir,
      request: normalizeMemoryTapSnapshotParams({ kinds: ["memory"] }, nowMs),
      nowMs,
    });

    expect(snapshot.candidates).toEqual([]);
    expect(snapshot.provenance.filteredSecretCount).toBe(0);
    expect(snapshot.health.checks).toContainEqual({
      id: "artifact-provenance",
      status: "warn",
      detail: `filtered raw evidence=${unsafeSnippets.length}`,
    });
    for (const snippet of unsafeSnippets) {
      expect(JSON.stringify(snapshot)).not.toContain(snippet);
    }
  });
});

describe("inspectMemoryTapSearchHealth", () => {
  const builtinConfig = (params: {
    enabled?: boolean;
    provider?: string;
    vector?: boolean;
    fullText?: boolean;
  }): OpenClawConfig =>
    ({
      agents: {
        defaults: {
          workspace: "/tmp/memory-tap-search-health",
          memorySearch: {
            enabled: params.enabled ?? true,
            provider: params.provider ?? "openai",
            store: { vector: { enabled: params.vector ?? true } },
            query: { hybrid: { enabled: params.fullText ?? true } },
          },
        },
      },
    }) as OpenClawConfig;

  const qmdConfig = (searchMode: "query" | "search" | "vsearch"): OpenClawConfig =>
    ({
      agents: { defaults: { workspace: "/tmp/memory-tap-search-health" } },
      memory: { backend: "qmd", qmd: { searchMode } },
    }) as OpenClawConfig;

  it.each([
    {
      label: "disabled builtin search",
      cfg: builtinConfig({ enabled: false }),
      expected: { status: "error", detail: "search unavailable" },
    },
    {
      label: "builtin FTS-only",
      cfg: builtinConfig({ provider: "none" }),
      expected: { status: "warn", detail: "full-text-only search configured" },
    },
    {
      label: "builtin with no configured search path",
      cfg: builtinConfig({ provider: "none", fullText: false }),
      expected: { status: "error", detail: "search unavailable" },
    },
    {
      label: "builtin vectors disabled with FTS",
      cfg: builtinConfig({ vector: false }),
      expected: { status: "warn", detail: "full-text-only search configured" },
    },
    {
      label: "builtin hybrid",
      cfg: builtinConfig({}),
      expected: { status: "ok", detail: "hybrid search configured" },
    },
    {
      label: "builtin vector-only",
      cfg: builtinConfig({ fullText: false }),
      expected: { status: "ok", detail: "vector search configured" },
    },
    {
      label: "QMD lexical-only",
      cfg: qmdConfig("search"),
      expected: { status: "warn", detail: "full-text-only search configured" },
    },
    {
      label: "QMD hybrid",
      cfg: qmdConfig("query"),
      expected: { status: "ok", detail: "hybrid search configured" },
    },
    {
      label: "QMD vector-only",
      cfg: qmdConfig("vsearch"),
      expected: { status: "ok", detail: "vector search configured" },
    },
  ] satisfies Array<{
    label: string;
    cfg: OpenClawConfig;
    expected: { status: string; detail: string };
  }>)("classifies $label without a live provider probe", ({ cfg, expected }) => {
    expect(inspectMemoryTapSearchHealth({ cfg, agentId: "main" })).toEqual(expected);
  });
});
