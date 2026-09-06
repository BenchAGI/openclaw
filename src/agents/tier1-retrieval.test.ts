import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SecretInput } from "../config/types.secrets.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import {
  buildTier1RetrievalContextFile,
  cleanTier1Query,
  renderTier1Body,
  rerankTier1Candidates,
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

type RerankerKnobs = {
  enabled?: boolean;
  baseUrl?: string;
  apiKey?: SecretInput;
  model?: string;
  timeoutMs?: number;
  minScore?: number;
  topK?: number;
};

function makeConfig(tier1?: Tier1Knobs, reranker?: RerankerKnobs): OpenClawConfig {
  return {
    memory: { search: { query: { tier1, reranker } } },
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

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
      searchFn: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([hit(0.9)]), 400);
        }),
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

  it("clamps caller maxResults/maxBytes overrides to the hard caps", async () => {
    const hits = Array.from({ length: 12 }, (_, i) => hit(0.9 - i * 0.01, `snippet number ${i}`));
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig({ enabled: true, minScore: 0.45, maxResults: 4, maxBytes: 1600 }),
      searchFn: async () => hits,
      maxResultsOverride: 50,
      maxBytesOverride: 100_000,
    });
    expect(out.injected).toBe(true);
    // 50 is clamped to the cap of 8 (not the config default of 4).
    expect(out.diag.injectedHits).toBe(8);
    // 100k is clamped to the 8192-byte cap.
    expect(Buffer.byteLength(out.file?.content ?? "", "utf8")).toBeLessThanOrEqual(8192);
  });

  it("honors small caller overrides below the caps", async () => {
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig({ enabled: true, minScore: 0.45, maxResults: 4, maxBytes: 1600 }),
      searchFn: async () => [hit(0.9, "first"), hit(0.8, "second"), hit(0.7, "third")],
      maxResultsOverride: 1,
    });
    expect(out.injected).toBe(true);
    expect(out.diag.injectedHits).toBe(1);
    expect(out.file?.content).toContain("first");
    expect(out.file?.content).not.toContain("second");
  });

  it("re-orders the injected slice via the config-enabled reranker", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      judgeResponse([
        { id: 0, score: 0.2 },
        { id: 1, score: 0.95 },
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig(
        { enabled: true, minScore: 0.45, maxResults: 4, maxBytes: 1600 },
        {
          enabled: true,
          baseUrl: "http://judge.local",
          apiKey: "judge-key",
          model: "judge",
          minScore: 0.1,
          topK: 8,
        },
      ),
      searchFn: async () => [hit(0.9, "cosine favorite"), hit(0.8, "judge favorite")],
    });
    expect(out.injected).toBe(true);
    const body = out.file?.content ?? "";
    expect(body.indexOf("judge favorite")).toBeLessThan(body.indexOf("cosine favorite"));
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer judge-key",
    });
  });

  it("resolves a reranker apiKey SecretRef before calling the judge", async () => {
    vi.stubEnv("TIER1_JUDGE_KEY", "env-judge-key");
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      judgeResponse([
        { id: 0, score: 0.9 },
        { id: 1, score: 0.8 },
      ]),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig(
        { enabled: true, minScore: 0.45, maxResults: 4, maxBytes: 1600 },
        {
          enabled: true,
          baseUrl: "http://judge.local",
          apiKey: { source: "env", provider: "default", id: "TIER1_JUDGE_KEY" },
          model: "judge",
          minScore: 0.1,
          topK: 8,
        },
      ),
      searchFn: async () => [hit(0.9, "first"), hit(0.8, "second")],
    });
    expect(out.injected).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer env-judge-key",
    });
  });

  it("skips the reranker request when a configured apiKey SecretRef is unresolved", async () => {
    const fetchSpy = vi.fn();
    const warn = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const out = await buildTier1RetrievalContextFile({
      ...BASE,
      config: makeConfig(
        { enabled: true, minScore: 0.45, maxResults: 4, maxBytes: 1600 },
        {
          enabled: true,
          baseUrl: "http://judge.local",
          apiKey: { source: "env", provider: "default", id: "MISSING_TIER1_JUDGE_KEY" },
          model: "judge",
          minScore: 0.1,
          topK: 8,
        },
      ),
      searchFn: async () => [hit(0.9, "cosine favorite"), hit(0.8, "judge favorite")],
      warn,
    });
    expect(out.injected).toBe(true);
    const body = out.file?.content ?? "";
    expect(body.indexOf("cosine favorite")).toBeLessThan(body.indexOf("judge favorite"));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warn.mock.calls.some(([message]) => String(message).includes("skipping reranker"))).toBe(
      true,
    );
  });
});

function judgeResponse(scores: Array<{ id: number; score: number }>) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ scores }) } }],
    }),
  } as unknown as Response;
}

describe("rerankTier1Candidates", () => {
  const cfg = {
    baseUrl: "http://judge.local",
    model: "judge-model",
    timeoutMs: 1000,
    minScore: 0.5,
    topK: 8,
  };
  const candidates = [hit(0.9, "alpha"), hit(0.8, "bravo"), hit(0.7, "charlie")];

  it("re-orders candidates by judge score within topK", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        judgeResponse([
          { id: 0, score: 0.6 },
          { id: 1, score: 0.95 },
          { id: 2, score: 0.7 },
        ]),
      ),
    );
    const out = await rerankTier1Candidates("q", candidates, cfg);
    expect(out.map((c) => c.snippet)).toEqual(["bravo", "charlie", "alpha"]);
  });

  it("drops candidates the judge scores below minScore", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        judgeResponse([
          { id: 0, score: 0.9 },
          { id: 1, score: 0.2 },
          { id: 2, score: 0.8 },
        ]),
      ),
    );
    const out = await rerankTier1Candidates("q", candidates, cfg);
    expect(out.map((c) => c.snippet)).toEqual(["alpha", "charlie"]);
  });

  it("limits the judged set to topK and drops the remainder on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        judgeResponse([
          { id: 0, score: 0.7 },
          { id: 1, score: 0.9 },
        ]),
      ),
    );
    const out = await rerankTier1Candidates("q", candidates, { ...cfg, topK: 2 });
    expect(out.map((c) => c.snippet)).toEqual(["bravo", "alpha"]);
  });

  it("fails open on a judge HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 }) as unknown as Response),
    );
    const out = await rerankTier1Candidates("q", candidates, cfg);
    expect(out).toBe(candidates);
  });

  it("fails open when the judge times out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const out = await rerankTier1Candidates("q", candidates, { ...cfg, timeoutMs: 120 });
    expect(out).toBe(candidates);
  });

  it("fails open on a non-JSON judge response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: true,
            json: async () => ({ choices: [{ message: { content: "no json here" } }] }),
          }) as unknown as Response,
      ),
    );
    const out = await rerankTier1Candidates("q", candidates, cfg);
    expect(out).toBe(candidates);
  });

  it("fails open when the judge floor empties the set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        judgeResponse([
          { id: 0, score: 0.1 },
          { id: 1, score: 0.2 },
          { id: 2, score: 0.3 },
        ]),
      ),
    );
    const out = await rerankTier1Candidates("q", candidates, cfg);
    expect(out).toBe(candidates);
  });

  it("skips the judge entirely without baseUrl/model or with a single candidate", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const single = [hit(0.9, "alpha")];
    expect(await rerankTier1Candidates("q", candidates, { ...cfg, baseUrl: undefined })).toBe(
      candidates,
    );
    expect(await rerankTier1Candidates("q", candidates, { ...cfg, model: undefined })).toBe(
      candidates,
    );
    expect(await rerankTier1Candidates("q", single, cfg)).toBe(single);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
