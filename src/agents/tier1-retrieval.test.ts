import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import {
  buildTier1RetrievalContextFile,
  cleanTier1Query,
  renderTier1Body,
  TIER1_FILE_NAME,
  type Tier1SearchFn,
} from "./tier1-retrieval.js";

type Tier1Knobs = {
  enabled?: boolean;
  maxResults?: number;
  minScore?: number;
  maxBytes?: number;
  timeoutMs?: number;
};

function makeConfig(tier1?: Tier1Knobs): OpenClawConfig {
  return {
    agents: { defaults: { memorySearch: { query: { tier1 } } } },
  } as unknown as OpenClawConfig;
}

function hit(
  score: number,
  snippet = "prior decision about the #1719 email draft",
  filePath = "memory/decisions/1719.md",
): MemorySearchResult {
  return { path: filePath, startLine: 1, endLine: 6, score, snippet, source: "memory" };
}

const BASE = {
  agentId: "aurelius",
  promptText: "what was the #1719 email draft we agreed on?",
  sessionKey: "agent:aurelius:slack:thread:T1",
  effectiveWorkspace: "/tmp/ws",
};

describe("cleanTier1Query", () => {
  it("strips slack mentions, @names, and slash-command prefixes", () => {
    expect(cleanTier1Query("<@U123> what about the roof quote?")).toBe(
      "what about the roof quote?",
    );
    expect(cleanTier1Query("@aurelius status please")).toBe("status please");
    expect(cleanTier1Query("/handoff cole the deal")).toBe("cole the deal");
  });
  it("collapses whitespace and caps length", () => {
    expect(cleanTier1Query("  a   b\n\nc ")).toBe("a b c");
    expect(cleanTier1Query("x".repeat(400)).length).toBe(256);
  });
  it("returns empty for non-strings / blank", () => {
    expect(cleanTier1Query("   ")).toBe("");
    expect(cleanTier1Query(undefined as unknown as string)).toBe("");
  });
});

describe("renderTier1Body", () => {
  it("includes the header + bounded entries and respects the byte cap", () => {
    const big = "y".repeat(5000);
    const { body, used } = renderTier1Body("q", [hit(0.8, big), hit(0.7, big)], 1600);
    expect(body).toContain("Retrieved prior context (Tier-1");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(1600);
    expect(used).toBeGreaterThanOrEqual(1);
  });
});

describe("buildTier1RetrievalContextFile", () => {
  it("is disabled when the flag is off (and never searched)", async () => {
    let searched = false;
    const searchFn: Tier1SearchFn = async () => {
      searched = true;
      return [hit(0.9)];
    };
    const out = await buildTier1RetrievalContextFile({ ...BASE, config: makeConfig(), searchFn });
    expect(out.injected).toBe(false);
    expect(out.diag.reason).toBe("disabled");
    expect(searched).toBe(false);
  });

  it("returns no-signal on a blank prompt", async () => {
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      promptText: "   ",
      config: makeConfig({ enabled: true }),
      searchFn: async () => [hit(0.9)],
    });
    expect(out.injected).toBe(false);
    expect(out.diag.reason).toBe("no-signal");
  });

  it("fails open when the search throws", async () => {
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig({ enabled: true }),
      searchFn: async () => {
        throw new Error("boom");
      },
    });
    expect(out.injected).toBe(false);
    expect(out.diag.reason).toBe("error");
  });

  it("fails open when the search exceeds the timeout budget", async () => {
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig({ enabled: true, timeoutMs: 100 }),
      searchFn: () => new Promise((resolve) => setTimeout(() => resolve([hit(0.9)]), 400)),
    });
    expect(out.injected).toBe(false);
    expect(out.diag.reason).toBe("timeout");
  });

  it("skips when every hit is below the relevance floor", async () => {
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig({ enabled: true, minScore: 0.45 }),
      searchFn: async () => [hit(0.2), hit(0.3)],
    });
    expect(out.injected).toBe(false);
    expect(out.diag.reason).toBe("below-threshold");
  });

  it("injects a bounded, score-ordered slice on good hits", async () => {
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig({ enabled: true, minScore: 0.45, maxResults: 2, maxBytes: 1600 }),
      searchFn: async () => [
        hit(0.51, "lower relevance"),
        hit(0.92, "the agreed copy"),
        hit(0.71, "middle"),
        hit(0.1, "below floor"),
      ],
    });
    expect(out.injected).toBe(true);
    expect(out.diag.reason).toBe("ok");
    expect(out.file?.path).toContain(TIER1_FILE_NAME);
    expect(Buffer.byteLength(out.file?.content ?? "", "utf8")).toBeLessThanOrEqual(1600);
    // top-2 by score: 0.92 then 0.71; the 0.51 and 0.1 are excluded.
    const body = out.file?.content ?? "";
    expect(body.indexOf("the agreed copy")).toBeLessThan(body.indexOf("middle"));
    expect(body).not.toContain("lower relevance");
    expect(body).not.toContain("below floor");
    expect(out.diag.injectedHits).toBe(2);
  });
});
