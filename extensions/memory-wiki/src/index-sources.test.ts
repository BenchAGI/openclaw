import { describe, expect, it } from "vitest";
import { selectIndexSources } from "./compile.js";
import type { WikiPageSummary } from "./markdown.js";

function sourcePage(relativePath: string, updatedAt?: string): WikiPageSummary {
  return {
    absolutePath: `/vault/${relativePath}`,
    relativePath,
    kind: "source",
    title: relativePath,
    aliases: [],
    sourceIds: [],
    linkTargets: [],
    claims: [],
    contradictions: [],
    questions: [],
    relationships: [],
    bestUsedFor: [],
    notEnoughFor: [],
    ...(updatedAt ? { updatedAt } : {}),
  };
}

const NOW = new Date("2026-05-28T00:00:00.000Z");

describe("selectIndexSources", () => {
  it("lists everything and hides nothing when both knobs are disabled (0)", () => {
    const sources = [
      sourcePage("sources/a.md", "2026-05-01T00:00:00.000Z"),
      sourcePage("sources/b.md", "2026-01-01T00:00:00.000Z"),
      sourcePage("sources/c.md"),
    ];
    const result = selectIndexSources({
      sources,
      maxSourcesListed: 0,
      sourceRetentionDays: 0,
      now: NOW,
    });
    expect(result.shown).toHaveLength(3);
    expect(result.hiddenCount).toBe(0);
  });

  it("caps to the N most-recently-updated sources and reports the overflow count", () => {
    const sources = [
      sourcePage("sources/old.md", "2026-02-01T00:00:00.000Z"),
      sourcePage("sources/newest.md", "2026-05-20T00:00:00.000Z"),
      sourcePage("sources/mid.md", "2026-04-01T00:00:00.000Z"),
    ];
    const result = selectIndexSources({
      sources,
      maxSourcesListed: 2,
      sourceRetentionDays: 0,
      now: NOW,
    });
    expect(result.shown.map((p) => p.relativePath)).toEqual([
      "sources/newest.md",
      "sources/mid.md",
    ]);
    expect(result.hiddenCount).toBe(1);
  });

  it("drops sources older than the retention window but keeps undated ones", () => {
    const sources = [
      sourcePage("sources/recent.md", "2026-05-20T00:00:00.000Z"),
      sourcePage("sources/stale.md", "2026-01-01T00:00:00.000Z"),
      sourcePage("sources/undated.md"),
    ];
    const result = selectIndexSources({
      sources,
      maxSourcesListed: 0,
      sourceRetentionDays: 45,
      now: NOW,
    });
    const shownPaths = result.shown.map((p) => p.relativePath);
    expect(shownPaths).toContain("sources/recent.md");
    expect(shownPaths).toContain("sources/undated.md");
    expect(shownPaths).not.toContain("sources/stale.md");
    expect(result.hiddenCount).toBe(1);
  });

  it("applies retention before the cap and counts all hidden sources", () => {
    const sources = [
      sourcePage("sources/r1.md", "2026-05-27T00:00:00.000Z"),
      sourcePage("sources/r2.md", "2026-05-26T00:00:00.000Z"),
      sourcePage("sources/r3.md", "2026-05-25T00:00:00.000Z"),
      sourcePage("sources/stale.md", "2026-01-01T00:00:00.000Z"),
    ];
    const result = selectIndexSources({
      sources,
      maxSourcesListed: 2,
      sourceRetentionDays: 45,
      now: NOW,
    });
    // stale dropped by retention; then top-2 of the 3 recent kept.
    expect(result.shown.map((p) => p.relativePath)).toEqual(["sources/r1.md", "sources/r2.md"]);
    expect(result.hiddenCount).toBe(2);
  });

  it("breaks ties deterministically by relativePath when updatedAt is equal", () => {
    const ts = "2026-05-20T00:00:00.000Z";
    const sources = [sourcePage("sources/zeta.md", ts), sourcePage("sources/alpha.md", ts)];
    const result = selectIndexSources({
      sources,
      maxSourcesListed: 1,
      sourceRetentionDays: 0,
      now: NOW,
    });
    expect(result.shown.map((p) => p.relativePath)).toEqual(["sources/alpha.md"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("does not mutate the input array", () => {
    const sources = [
      sourcePage("sources/a.md", "2026-01-01T00:00:00.000Z"),
      sourcePage("sources/b.md", "2026-05-20T00:00:00.000Z"),
    ];
    const before = sources.map((p) => p.relativePath);
    selectIndexSources({ sources, maxSourcesListed: 1, sourceRetentionDays: 0, now: NOW });
    expect(sources.map((p) => p.relativePath)).toEqual(before);
  });
});
