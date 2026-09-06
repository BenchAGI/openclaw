import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeConfig, resetConfigRuntimeState } from "../../config/config.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { captureEnv } from "../../test-utils/env.js";
import { localSeatHandlers } from "./local-seat.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir: string | undefined;

async function invokeLocalSeat(params: Record<string, unknown>) {
  const responses: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
  const options: GatewayRequestHandlerOptions = {
    req: {
      type: "req",
      id: "local-seat-test",
      method: "local-seat.capture",
      params,
    },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      responses.push({ ok, payload, error });
    },
    context: { getRuntimeConfig } as GatewayRequestHandlerOptions["context"],
  };
  const handler = localSeatHandlers["local-seat.capture"];
  if (!handler) {
    throw new Error("local-seat.capture handler is not registered");
  }
  await handler(options);
  return responses.at(-1);
}

function expectOkPayload(response: Awaited<ReturnType<typeof invokeLocalSeat>>): unknown {
  expect(response?.ok).toBe(true);
  if (!response || !response.ok) {
    throw new Error("expected local-seat.capture to succeed");
  }
  return response.payload;
}

describe("local-seat.capture", () => {
  afterEach(async () => {
    resetSystemEventsForTest();
    resetConfigRuntimeState();
    envSnapshot.restore();
    if (stateDir) {
      await rm(stateDir, { recursive: true, force: true });
      stateDir = undefined;
    }
  });

  it("persists a capture and routes untrusted wake context to the selected agent", async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-local-seat-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_CONFIG_PATH;
    resetConfigRuntimeState();

    const response = await invokeLocalSeat({
      agentId: "aurelius",
      seatKind: "codex-cli",
      seatSessionId: "seat-1",
      event: "user_prompt",
      text: "ship the bridge",
      cwd: "/tmp/project",
      ts: "2026-06-11T01:02:03.000Z",
    });

    const payload = expectOkPayload(response) as { capturePath: string; queued: boolean };
    expect(payload.queued).toBe(true);
    expect(payload.capturePath).toBe(
      path.join(stateDir, "local-seat-captures", "aurelius", "2026-06-11.jsonl"),
    );
    const lines = (await readFile(payload.capturePath, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      agentId: "aurelius",
      seatKind: "codex-cli",
      seatSessionId: "seat-1",
      event: "user_prompt",
      text: "ship the bridge",
    });
    expect(peekSystemEvents("agent:aurelius:main").join("\n")).toContain(
      "Local seat capture (untrusted context)",
    );
    expect(peekSystemEvents("agent:aurelius:main").join("\n")).toContain("ship the bridge");
  });

  it("persists without queueing when wake is false", async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-local-seat-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetConfigRuntimeState();

    const response = await invokeLocalSeat({
      agentId: "aurelius",
      seatKind: "claude-code",
      seatSessionId: "seat-2",
      event: "session_start",
      text: "started",
      wake: false,
    });

    const payload = expectOkPayload(response) as { queued: boolean };
    expect(payload.queued).toBe(false);
    expect(peekSystemEvents("agent:aurelius:main")).toEqual([]);
  });

  it("does not queue lifecycle events by default", async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-local-seat-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetConfigRuntimeState();

    for (const event of ["session_start", "session_stop"] as const) {
      const response = await invokeLocalSeat({
        agentId: "aurelius",
        seatKind: "claude-code",
        seatSessionId: `seat-${event}`,
        event,
        text: event,
        ts: "2026-06-11T01:02:03.000Z",
      });

      const payload = expectOkPayload(response) as { queued: boolean };
      expect(payload.queued).toBe(false);
    }
    expect(peekSystemEvents("agent:aurelius:main")).toEqual([]);
  });

  it("normalizes dot-segment agent ids before choosing a capture path", async () => {
    stateDir = await mkdtemp(path.join(os.tmpdir(), "openclaw-local-seat-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetConfigRuntimeState();

    const response = await invokeLocalSeat({
      agentId: "..",
      seatKind: "codex-cli",
      seatSessionId: "seat-3",
      event: "summary",
      summary: "bounded note",
      ts: "2026-06-11T01:02:03.000Z",
      wake: false,
    });

    const payload = expectOkPayload(response) as { capturePath: string; queued: boolean };
    expect(payload.capturePath).toBe(
      path.join(stateDir, "local-seat-captures", "main", "2026-06-11.jsonl"),
    );
    const lines = (await readFile(payload.capturePath, "utf8")).trim().split("\n");
    expect(JSON.parse(lines[0] ?? "{}")).toMatchObject({
      agentId: "main",
      seatSessionId: "seat-3",
      summary: "bounded note",
    });
  });

  it("rejects invalid capture payloads", async () => {
    const response = await invokeLocalSeat({
      agentId: "aurelius",
      seatKind: "unknown",
      seatSessionId: "seat-3",
      event: "user_prompt",
    });

    expect(response?.ok).toBe(false);
    expect(response?.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects numeric timestamps from incompatible clients", async () => {
    const response = await invokeLocalSeat({
      agentId: "aurelius",
      seatKind: "codex-cli",
      seatSessionId: "seat-4",
      event: "user_prompt",
      text: "bad timestamp",
      ts: Date.now(),
    });

    expect(response?.ok).toBe(false);
    expect(response?.error).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("rejects overlarge local seat ids before queueing untrusted context", async () => {
    const response = await invokeLocalSeat({
      agentId: "aurelius",
      seatKind: "codex-cli",
      seatSessionId: "x".repeat(1_001),
      event: "user_prompt",
      text: "bounded",
    });

    expect(response?.ok).toBe(false);
    expect(response?.error).toMatchObject({ code: "INVALID_REQUEST" });
    expect(peekSystemEvents("agent:aurelius:main")).toEqual([]);
  });
});
