import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import sessionDigestPlugin from "./index.js";

type SessionEndHandler = (
  event: {
    sessionId: string;
    sessionKey?: string;
    messageCount: number;
    durationMs?: number;
    reason?: string;
    sessionFile?: string;
    transcriptArchived?: boolean;
  },
  ctx: { agentId?: string; sessionId: string; sessionKey?: string },
) => Promise<void> | void;

async function setupPlugin(pluginConfig?: Record<string, unknown>) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "session-digest-ws-"));
  const handlers = new Map<string, SessionEndHandler>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const api = {
    id: "session-digest",
    name: "Session Digest",
    config: {
      agents: {
        defaults: { workspace },
        list: [{ id: "aurelius", workspace }],
      },
    },
    pluginConfig,
    logger,
    on: (name: string, handler: SessionEndHandler) => {
      handlers.set(name, handler);
    },
    registerService: vi.fn(),
  } as unknown as OpenClawPluginApi;
  sessionDigestPlugin.register(api);
  const handler = handlers.get("session_end");
  if (!handler) {
    throw new Error("session_end handler was not registered");
  }
  return { workspace, handler, logger };
}

async function writeTranscript(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "session-digest-transcript-"));
  const file = path.join(dir, "abc-session.jsonl");
  await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

describe("session-digest plugin", () => {
  test("captures a digest with transcript intent on session_end", async () => {
    const { workspace, handler } = await setupPlugin();
    const sessionFile = await writeTranscript([
      { type: "session", version: 3, id: "abc-session", timestamp: "2026-06-04T01:00:00.000Z" },
      {
        type: "message",
        id: "m1",
        timestamp: "2026-06-04T01:00:01.000Z",
        message: { role: "user", content: "<system-reminder>injected</system-reminder>" },
      },
      {
        type: "message",
        id: "m2",
        timestamp: "2026-06-04T01:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Plan the CarbonBlack roofing demo for Friday" }],
        },
      },
      {
        type: "message",
        id: "m3",
        timestamp: "2026-06-04T01:00:30.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "On it." }] },
      },
    ]);

    await handler(
      {
        sessionId: "abc-session",
        sessionKey: "agent:aurelius:slack:dm",
        messageCount: 3,
        durationMs: 120_000,
        reason: "idle",
        sessionFile,
      },
      { agentId: "aurelius", sessionId: "abc-session", sessionKey: "agent:aurelius:slack:dm" },
    );

    const streamPath = path.join(workspace, "state", "session-digests", "session-digests.jsonl");
    const stream = await readFile(streamPath, "utf8");
    const digest = JSON.parse(stream.trim());
    expect(digest.version).toBe(1);
    expect(digest.sessionId).toBe("abc-session");
    expect(digest.agentId).toBe("aurelius");
    expect(digest.surface).toBe("openclaw-gateway");
    expect(digest.intent).toBe("Plan the CarbonBlack roofing demo for Friday");
    expect(digest.privacy).toBe("local-private");
    expect(digest.promotionHint).toBe("review");
    expect(digest.entities).toContain("reason:idle");
    expect(digest.sourceRefs).toContain(sessionFile);
    expect(digest.goalTag).toBeUndefined();

    const bySession = JSON.parse(
      await readFile(
        path.join(workspace, "state", "session-digests", "by-session", "abc-session.json"),
        "utf8",
      ),
    );
    expect(bySession.digestId).toBe(digest.digestId);
  });

  test("emits a stub digest when the transcript is missing", async () => {
    const { workspace, handler } = await setupPlugin();
    await handler(
      {
        sessionId: "ghost-session",
        messageCount: 5,
        reason: "shutdown",
        sessionFile: path.join(os.tmpdir(), "does-not-exist", "ghost.jsonl"),
        transcriptArchived: true,
      },
      { agentId: "aurelius", sessionId: "ghost-session" },
    );
    const stream = await readFile(
      path.join(workspace, "state", "session-digests", "session-digests.jsonl"),
      "utf8",
    );
    const digest = JSON.parse(stream.trim());
    expect(digest.intent).toBe("");
    expect(digest.notes).toContain("transcript archived");
  });

  test("skips empty sessions and compaction transitions", async () => {
    const { workspace, handler } = await setupPlugin();
    await handler(
      { sessionId: "empty", messageCount: 0, reason: "new" },
      { agentId: "aurelius", sessionId: "empty" },
    );
    await handler(
      { sessionId: "compacting", messageCount: 9, reason: "compaction" },
      { agentId: "aurelius", sessionId: "compacting" },
    );
    await expect(
      readFile(path.join(workspace, "state", "session-digests", "session-digests.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("never throws out of the handler on write failure", async () => {
    const { workspace, handler, logger } = await setupPlugin({ digestDir: "blocked/digests" });
    // A regular file where the digest dir should go makes mkdir fail (ENOTDIR).
    await writeFile(path.join(workspace, "blocked"), "not a directory\n", "utf8");
    await expect(
      handler(
        { sessionId: "boom", messageCount: 2, reason: "reset" },
        { agentId: "aurelius", sessionId: "boom" },
      ),
    ).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });

  test("honors captureIntent=false config", async () => {
    const { workspace, handler } = await setupPlugin({ captureIntent: false });
    const sessionFile = await writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-06-04T01:00:01.000Z",
        message: { role: "user", content: "should not be read" },
      },
    ]);
    await handler(
      { sessionId: "no-intent", messageCount: 1, reason: "daily", sessionFile },
      { agentId: "aurelius", sessionId: "no-intent" },
    );
    const stream = await readFile(
      path.join(workspace, "state", "session-digests", "session-digests.jsonl"),
      "utf8",
    );
    expect(JSON.parse(stream.trim()).intent).toBe("");
  });
});
