import { beforeEach, describe, expect, it, vi } from "vitest";
import { probeSlack } from "./probe.js";

const authTestMock = vi.hoisted(() => vi.fn());
const createSlackWebClientMock = vi.hoisted(() => vi.fn());
const withTimeoutMock = vi.hoisted(() => vi.fn());
const bridgeHealthzMock = vi.hoisted(() => vi.fn());
const createAgentKitBridgeClientMock = vi.hoisted(() => vi.fn());

vi.mock("./client.js", () => ({
  createSlackWebClient: createSlackWebClientMock,
}));

vi.mock("openclaw/plugin-sdk/text-runtime", () => ({
  withTimeout: withTimeoutMock,
}));

vi.mock("./monitor/agent-kit-bridge.js", () => ({
  createAgentKitBridgeClient: createAgentKitBridgeClientMock,
}));

describe("probeSlack", () => {
  beforeEach(() => {
    authTestMock.mockReset();
    createSlackWebClientMock.mockReset();
    withTimeoutMock.mockReset();
    bridgeHealthzMock.mockReset();
    createAgentKitBridgeClientMock.mockReset();

    createSlackWebClientMock.mockReturnValue({
      auth: {
        test: authTestMock,
      },
    });
    withTimeoutMock.mockImplementation(async (promise: Promise<unknown>) => await promise);
    createAgentKitBridgeClientMock.mockReturnValue({
      healthz: bridgeHealthzMock,
    });
  });

  it("maps Slack auth metadata on success", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(100).mockReturnValueOnce(145);
    authTestMock.mockResolvedValue({
      ok: true,
      user_id: "U123",
      user: "openclaw-bot",
      team_id: "T123",
      team: "OpenClaw",
    });

    await expect(probeSlack("xoxb-test", 2500)).resolves.toEqual({
      ok: true,
      status: 200,
      elapsedMs: 45,
      bot: { id: "U123", name: "openclaw-bot" },
      team: { id: "T123", name: "OpenClaw" },
      bridgeStatus: "disabled",
    });
    expect(createSlackWebClientMock).toHaveBeenCalledWith("xoxb-test");
    expect(withTimeoutMock).toHaveBeenCalledWith(expect.any(Promise), 2500);
  });

  it("keeps optional auth metadata fields undefined when Slack omits them", async () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(200).mockReturnValueOnce(235);
    authTestMock.mockResolvedValue({ ok: true });

    const result = await probeSlack("xoxb-test");

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.elapsedMs).toBe(35);
    expect(result.bot).toStrictEqual({ id: undefined, name: undefined });
    expect(result.team).toStrictEqual({ id: undefined, name: undefined });
  });

  it("reports disabled bridge status when no bridge config is provided", async () => {
    authTestMock.mockResolvedValue({ ok: true });

    const result = await probeSlack("xoxb-test");

    expect(result.bridgeStatus).toBe("disabled");
    expect(createAgentKitBridgeClientMock).not.toHaveBeenCalled();
  });

  it("reports healthy bridge status for enabled bridge config", async () => {
    authTestMock.mockResolvedValue({ ok: true });
    bridgeHealthzMock.mockResolvedValue({
      ok: true,
      version: "w2.3",
      latency_ms: 12,
    });

    const result = await probeSlack("xoxb-test", 2500, {
      enabled: true,
      url: "http://127.0.0.1:8717",
      timeoutMs: 60000,
      mode: "runtime-adapter",
      policy: "inherit",
    });

    expect(result.bridgeStatus).toBe("ok");
    expect(result.bridgeVersion).toBe("w2.3");
    expect(result.bridgeElapsedMs).toBe(12);
    expect(createAgentKitBridgeClientMock).toHaveBeenCalledWith({
      enabled: true,
      url: "http://127.0.0.1:8717",
      timeoutMs: 2000,
      mode: "runtime-adapter",
      policy: "inherit",
    });
  });

  it("reports unreachable bridge status for enabled bridge failures", async () => {
    authTestMock.mockResolvedValue({ ok: true });
    bridgeHealthzMock.mockResolvedValue({
      ok: false,
      error: {
        code: "transport_error",
        message: "connection refused",
        retryable: true,
        latency_ms: 8,
      },
    });

    const result = await probeSlack("xoxb-test", 2500, {
      enabled: true,
      url: "http://127.0.0.1:8717",
      timeoutMs: 1500,
      mode: "runtime-adapter",
      policy: "inherit",
    });

    expect(result.bridgeStatus).toBe("unreachable");
    expect(result.bridgeError).toBe("connection refused");
    expect(result.bridgeElapsedMs).toBe(8);
  });
});
