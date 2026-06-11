import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetConfigRuntimeState } from "../../config/config.js";
import { peekSystemEvents, resetSystemEventsForTest } from "../../infra/system-events.js";
import { captureEnv } from "../../test-utils/env.js";
import { localSeatHandlers } from "./local-seat.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH"]);
let stateDir: string | undefined;

async function invokeLocalSeat(params: Record<string, unknown>) {
  const responses: Array<{ ok: boolean; payload: unknown; error: unknown }> = [];
  await localSeatHandlers["local-seat.capture"]({
    params,
    respond: (ok, payload, error) => responses.push({ ok, payload, error }),
  } as GatewayRequestHandlerOptions);
  return responses.at(-1);
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

    expect(response?.ok).toBe(true);
    const payload = response?.payload as { capturePath: string; queued: boolean };
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

    expect(response?.ok).toBe(true);
    expect((response?.payload as { queued: boolean }).queued).toBe(false);
    expect(peekSystemEvents("agent:aurelius:main")).toEqual([]);
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
});
