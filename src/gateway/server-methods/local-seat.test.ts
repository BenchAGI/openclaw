import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { peekSystemEventEntries, resetSystemEventsForTest } from "../../infra/system-events.js";
import { ErrorCodes } from "../protocol/index.js";
import { localSeatHandlers } from "./local-seat.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

vi.mock("../../config/sessions.js", () => ({
  resolveAgentMainSessionKey: ({ agentId }: { agentId: string }) => `agent:${agentId}:main`,
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({}),
}));

function invoke(params: Record<string, unknown>) {
  const respond = vi.fn();
  localSeatHandlers["local-seat.capture"]({
    params,
    respond: respond as never,
    context: {} as never,
    client: null,
    req: { type: "req", id: "req-1", method: "local-seat.capture" },
    isWebchatConnect: () => false,
  });
  return respond.mock.calls[0] as RespondCall | undefined;
}

describe("local-seat.capture handler", () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeEach(() => {
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-local-seat-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    resetSystemEventsForTest();
  });

  afterEach(() => {
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
    resetSystemEventsForTest();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  it("persists bounded capture JSONL and queues an untrusted system event", () => {
    const call = invoke({
      agentId: "aurelius",
      seatKind: "claude-code",
      seatSessionId: "seat-123",
      event: "user_prompt",
      summary: "Review the deploy",
      text: "Please check the deployment runbook.",
      cwd: "/tmp/work",
      ts: 1_779_840_000_000,
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, queued: true });
    const capturePath = (call?.[1] as { capturePath?: string } | undefined)?.capturePath;
    expect(capturePath).toBe(path.join(stateDir, "local-seat-captures", "aurelius", "2026-05-27.jsonl"));

    const lines = fs.readFileSync(capturePath ?? "", "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      schemaVersion: 1,
      agentId: "aurelius",
      seatKind: "claude-code",
      seatSessionId: "seat-123",
      event: "user_prompt",
      summary: "Review the deploy",
      text: "Please check the deployment runbook.",
    });

    const events = peekSystemEventEntries("agent:aurelius:main");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      trusted: false,
      contextKey: "local-seat:aurelius:seat-123:user_prompt",
    });
    expect(events[0]?.text).toContain("Local Claude Code seat capture");
  });

  it("rejects invalid payloads without writing a capture", () => {
    const call = invoke({
      agentId: "aurelius",
      seatKind: "unknown",
      seatSessionId: "seat-123",
      event: "user_prompt",
    });

    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.code).toBe(ErrorCodes.INVALID_REQUEST);
    expect(call?.[2]?.message).toContain("invalid local-seat.capture params");
    expect(fs.existsSync(path.join(stateDir, "local-seat-captures"))).toBe(false);
  });

  it("stores captures without wake events when wake is false", () => {
    const call = invoke({
      agentId: "aurelius",
      seatKind: "codex-cli",
      seatSessionId: "seat-123",
      event: "session_start",
      wake: false,
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]).toMatchObject({ ok: true, queued: false });
    expect(peekSystemEventEntries("agent:aurelius:main")).toHaveLength(0);
  });
});
