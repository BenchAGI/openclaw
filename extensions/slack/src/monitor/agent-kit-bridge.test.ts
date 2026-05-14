import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackAgentKitBridgeConfig } from "../types.js";
import {
  createAgentKitBridgeClient,
  type AgentKitBridgeLogger,
  type BridgeRunRequest,
} from "./agent-kit-bridge.js";

function config(overrides: Partial<SlackAgentKitBridgeConfig> = {}): SlackAgentKitBridgeConfig {
  return {
    enabled: true,
    url: "http://127.0.0.1:8717",
    timeoutMs: 1000,
    mode: "runtime-adapter",
    policy: "inherit",
    ...overrides,
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function request(overrides: Partial<BridgeRunRequest> = {}): BridgeRunRequest {
  return {
    session_key: "slack:T123:C123:1715620000.000100",
    user_text: "raw user text must not be logged",
    surface_context: {
      account_id: "bench-aurelius",
      team_id: "T123",
      app_id: "A123",
      channel_id: "C123",
      thread_ts: "1715620000.000100",
      user_id: "U123",
      surface_type: "assistant_pane",
      turn_source_event: "assistant_thread_message",
      turn_source_ts: "1715620001.000200",
    },
    ...overrides,
  };
}

function captureLogger(): { logger: AgentKitBridgeLogger; lines: string[] } {
  const lines: string[] = [];
  const capture = (...args: unknown[]) => lines.push(JSON.stringify(args));
  return {
    logger: {
      info: capture,
      warn: capture,
      error: capture,
      debug: capture,
    },
    lines,
  };
}

describe("createAgentKitBridgeClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("skips HTTP when the bridge is disabled", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const client = createAgentKitBridgeClient(config({ enabled: false }), { fetchFn });

    await expect(client.healthz()).resolves.toMatchObject({ disabled: true });
    await expect(client.run(request())).resolves.toMatchObject({
      ok: false,
      error: { code: "disabled", disabled: true },
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("maps healthy healthz and run responses", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ ok: true, version: "w2.3" }))
      .mockResolvedValueOnce(
        jsonResponse({
          response_text: "sidecar response",
          session_id: "claude-session-1",
          tool_intents: [{ type: "slack_reaction", emoji: "eyes" }],
        }),
      );
    const client = createAgentKitBridgeClient(config(), { fetchFn });

    await expect(client.healthz()).resolves.toMatchObject({
      ok: true,
      version: "w2.3",
    });
    await expect(client.run(request())).resolves.toEqual({
      ok: true,
      value: {
        response_text: "sidecar response",
        session_id: "claude-session-1",
        tool_intents: [{ type: "slack_reaction", emoji: "eyes" }],
      },
    });
    expect(fetchFn.mock.calls[0]?.[0]).toBeInstanceOf(URL);
    expect((fetchFn.mock.calls[0]?.[0] as URL).href).toBe("http://127.0.0.1:8717/healthz");
    expect(fetchFn.mock.calls[1]?.[0]).toBeInstanceOf(URL);
    expect((fetchFn.mock.calls[1]?.[0] as URL).href).toBe("http://127.0.0.1:8717/run");
    expect(fetchFn.mock.calls[1]?.[1]?.method).toBe("POST");
  });

  it("maps 5xx responses to typed transport errors", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ error: "down" }, { status: 503 }));
    const client = createAgentKitBridgeClient(config(), { fetchFn });

    await expect(client.run(request())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "transport_error",
        status: 503,
        retryable: true,
      },
    });
  });

  it("maps network failures to typed transport errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new Error("ECONNREFUSED"));
    const client = createAgentKitBridgeClient(config(), { fetchFn });

    await expect(client.healthz()).resolves.toMatchObject({
      ok: false,
      error: {
        code: "transport_error",
        retryable: true,
      },
    });
  });

  it("maps body-level run errors to typed runtime errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        response_text: "",
        tool_intents: [],
        error: "model tool failed",
      }),
    );
    const client = createAgentKitBridgeClient(config(), { fetchFn });

    await expect(client.run(request())).resolves.toMatchObject({
      ok: false,
      error: {
        code: "runtime_error",
        retryable: false,
        message: "model tool failed",
      },
    });
  });

  it("maps timeouts to typed timeout errors", async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    });
    const client = createAgentKitBridgeClient(config({ timeoutMs: 25 }), { fetchFn });
    const result = client.run(request());

    await vi.advanceTimersByTimeAsync(25);

    await expect(result).resolves.toMatchObject({
      ok: false,
      error: { code: "timeout" },
    });
  });

  it("maps invalid response shapes to typed validation errors", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ response_text: "nope" }));
    const client = createAgentKitBridgeClient(config(), { fetchFn });

    await expect(client.run(request())).resolves.toMatchObject({
      ok: false,
      error: { code: "validation_error" },
    });
  });

  it("logs metadata only", async () => {
    const { logger, lines } = captureLogger();
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        response_text: "raw response text must not be logged",
        session_id: "claude-session-1",
        tool_intents: [],
      }),
    );
    const client = createAgentKitBridgeClient(config(), { fetchFn, logger });

    await expect(client.run(request())).resolves.toMatchObject({ ok: true });

    const logs = lines.join("\n");
    expect(logs).toContain("agent_kit_bridge.run");
    expect(logs).toContain("bench-aurelius");
    expect(logs).not.toContain("raw user text must not be logged");
    expect(logs).not.toContain("raw response text must not be logged");
  });
});
