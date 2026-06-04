import { afterEach, describe, expect, it, vi } from "vitest";
import { BenchSyncClient, BenchSyncClientError, resolveBenchSyncUrl } from "./client.js";

const BASE = "https://benchagi.example";
const INSTANCE = "jBA5cCK6fyMCzIk3SoWF";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeClient(fetchFn: typeof fetch, apiBaseUrl = BASE): BenchSyncClient {
  return new BenchSyncClient(
    { apiBaseUrl, instanceId: INSTANCE, apiKey: "bench_test_secret" },
    { fetchFn },
  );
}

function makeClientWithConfig(
  fetchFn: typeof fetch,
  config: Partial<ConstructorParameters<typeof BenchSyncClient>[0]>,
): BenchSyncClient {
  return new BenchSyncClient(
    { apiBaseUrl: BASE, instanceId: INSTANCE, apiKey: "bench_test_secret", ...config },
    { fetchFn },
  );
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

afterEach(() => {
  vi.useRealTimers();
});

/** Read the resolved request URL + init from the nth fetch mock call. */
function callAt(mock: FetchMock, index: number): { url: string; init?: RequestInit } {
  const call = mock.mock.calls[index];
  if (!call) {
    throw new Error(`no fetch call at index ${index}`);
  }
  const [input, init] = call;
  // The client always resolves to a string URL before calling fetch.
  if (typeof input !== "string") {
    throw new Error("expected the client to call fetch with a string URL");
  }
  return { url: input, init };
}

describe("resolveBenchSyncUrl origin pin", () => {
  it("resolves a relative path against the base origin", () => {
    expect(resolveBenchSyncUrl(BASE, "/api/v1/x")).toBe(`${BASE}/api/v1/x`);
  });

  it("accepts an absolute URL on the same origin", () => {
    expect(resolveBenchSyncUrl(BASE, `${BASE}/api/v1/x`)).toBe(`${BASE}/api/v1/x`);
  });

  it("rejects a URL whose origin differs", () => {
    expect(() => resolveBenchSyncUrl(BASE, "https://evil.example/api/v1/x")).toThrowError(
      BenchSyncClientError,
    );
  });

  it("rejects a protocol-relative URL pointing off-origin", () => {
    expect(() => resolveBenchSyncUrl(BASE, "//evil.example/x")).toThrowError(BenchSyncClientError);
  });
});

describe("BenchSyncClient request construction", () => {
  it("posts agent task cards to the instance-scoped sync URL with X-API-Key", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.postAgentTaskCards({ cards: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = callAt(fetchMock, 0);
    expect(url).toBe(`${BASE}/api/v1/instances/${INSTANCE}/agent-tasks/sync`);
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("bench_test_secret");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("posts skill proposals to the skill-proposals sync URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.postSkillProposals({ proposals: [] });

    const { url } = callAt(fetchMock, 0);
    expect(url).toBe(`${BASE}/api/v1/instances/${INSTANCE}/skill-proposals/sync`);
  });

  it("pulls directives with types + cursor query params and GET method", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ directives: [] }));
    const client = makeClient(fetchMock);

    await client.pullDirectives({
      types: ["skill_proposal_decision"],
      cursor: "abc123",
    });

    const { url, init } = callAt(fetchMock, 0);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(
      `${BASE}/api/v1/instances/${INSTANCE}/sync/directives`,
    );
    expect(parsed.searchParams.get("types")).toBe("skill_proposal_decision");
    expect(parsed.searchParams.get("cursor")).toBe("abc123");
    expect(init?.method).toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBe("bench_test_secret");
    // GET has no body content-type.
    expect(headers["content-type"]).toBeUndefined();
  });

  it("omits the cursor param when none is supplied", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ directives: [] }));
    const client = makeClient(fetchMock);

    await client.pullDirectives({ types: ["skill_proposal_decision"] });

    const parsed = new URL(callAt(fetchMock, 0).url);
    expect(parsed.searchParams.has("cursor")).toBe(false);
  });

  it("acks a directive at the per-directive ack URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.ackDirective("dir-9", {
      status: "applied",
      result: { proposalId: "proposal-1" },
    });

    const { url, init } = callAt(fetchMock, 0);
    expect(url).toBe(`${BASE}/api/v1/instances/${INSTANCE}/sync/directives/dir-9/ack`);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      status: "applied",
      result: { proposalId: "proposal-1" },
    });
  });

  it("url-encodes directive ids in the ack path", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true }));
    const client = makeClient(fetchMock);

    await client.ackDirective("a/b c", { status: "skipped", reason: "already applied" });

    const { url } = callAt(fetchMock, 0);
    expect(url).toBe(`${BASE}/api/v1/instances/${INSTANCE}/sync/directives/a%2Fb%20c/ack`);
  });
});

describe("BenchSyncClient error mapping", () => {
  it("maps an HTTP error body to a typed error with status + code", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "instance not found", code: "no_instance" }, { status: 404 }),
    );
    const client = makeClient(fetchMock);

    await expect(client.postAgentTaskCards({ cards: [] })).rejects.toMatchObject({
      name: "BenchSyncClientError",
      status: 404,
      code: "no_instance",
    });
  });

  it("maps invalid JSON to a typed error", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const client = makeClient(fetchMock);

    await expect(client.pullDirectives({ types: [] })).rejects.toBeInstanceOf(BenchSyncClientError);
  });

  it("rejects a redirect that points off-origin", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/steal" },
        }),
    );
    const client = makeClient(fetchMock);

    await expect(client.postAgentTaskCards({ cards: [] })).rejects.toBeInstanceOf(
      BenchSyncClientError,
    );
  });

  it("rejects a redirect even without a usable location header", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 307 }));
    const client = makeClient(fetchMock);

    await expect(client.postSkillProposals({ proposals: [] })).rejects.toMatchObject({
      code: "redirect",
    });
  });

  it("rejects an oversized response declared by content-length", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200, headers: { "content-length": "99" } }),
    );
    const client = makeClientWithConfig(fetchMock, { maxResponseBytes: 2 });

    await expect(client.pullDirectives({ types: [] })).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("rejects an oversized response after reading the body bytes", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{"ok":true}', { status: 200 }));
    const client = makeClientWithConfig(fetchMock, { maxResponseBytes: 2 });

    await expect(client.pullDirectives({ types: [] })).rejects.toMatchObject({
      code: "response_too_large",
    });
  });

  it("maps request timeouts to an aborted client error", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        }),
    );
    const client = makeClientWithConfig(fetchMock, { timeoutMs: 5 });

    const request = client.pullDirectives({ types: [] });
    const expectation = expect(request).rejects.toMatchObject({ code: "aborted" });
    await vi.advanceTimersByTimeAsync(5);

    await expectation;
  });

  it("requires a non-empty apiKey at construction", () => {
    expect(
      () => new BenchSyncClient({ apiBaseUrl: BASE, instanceId: INSTANCE, apiKey: "" }),
    ).toThrow(BenchSyncClientError);
  });
});
