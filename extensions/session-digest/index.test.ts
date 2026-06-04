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

async function setupPlugin(
  pluginConfig?: Record<string, unknown>,
  runtimePluginConfig: Record<string, unknown> | undefined = pluginConfig,
) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "session-digest-ws-"));
  const handlers = new Map<string, SessionEndHandler>();
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const config = {
    agents: {
      defaults: { workspace },
      list: [{ id: "aurelius", workspace }],
    },
    ...(runtimePluginConfig
      ? {
          plugins: {
            entries: {
              "session-digest": {
                config: runtimePluginConfig,
              },
            },
          },
        }
      : {}),
  };
  const api = {
    id: "session-digest",
    name: "Session Digest",
    config,
    pluginConfig,
    runtime: {
      config: {
        current: () => config,
      },
    },
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

  test("uses live plugin config when handling session_end", async () => {
    const { workspace, handler } = await setupPlugin(
      { captureIntent: true },
      { captureIntent: false, digestDir: "live-digests" },
    );
    const sessionFile = await writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-06-04T01:00:01.000Z",
        message: { role: "user", content: "should not be captured" },
      },
    ]);

    await handler(
      { sessionId: "live-config", messageCount: 1, reason: "idle", sessionFile },
      { agentId: "aurelius", sessionId: "live-config" },
    );

    const stream = await readFile(
      path.join(workspace, "live-digests", "session-digests.jsonl"),
      "utf8",
    );
    expect(JSON.parse(stream.trim()).intent).toBe("");
  });

  test("captures intent from input_text transcript blocks", async () => {
    const { workspace, handler } = await setupPlugin();
    const sessionFile = await writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-06-04T01:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
            { type: "input_text", text: "Inspect the OpenResponses" },
            { type: "input_text", text: "transcript path" },
          ],
        },
      },
    ]);

    await handler(
      { sessionId: "input-text", messageCount: 1, reason: "idle", sessionFile },
      { agentId: "aurelius", sessionId: "input-text" },
    );

    const stream = await readFile(
      path.join(workspace, "state", "session-digests", "session-digests.jsonl"),
      "utf8",
    );
    expect(JSON.parse(stream.trim()).intent).toBe("Inspect the OpenResponses transcript path");
  });

  test("strips inbound metadata envelopes from captured intent", async () => {
    const { workspace, handler } = await setupPlugin();
    const sessionFile = await writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-06-04T01:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "text", text: "Conversation info (untrusted metadata):" },
            { type: "text", text: '```json\n{"channel":"telegram","message_id":"msg-abc"}\n```' },
            { type: "text", text: "Sender (untrusted metadata):" },
            { type: "text", text: '```json\n{"id":"user-1","name":"Ada"}\n```' },
            {
              type: "text",
              text: "Reply chain of current user message (untrusted, nearest first):",
            },
            { type: "text", text: '```json\n[{"body":"quoted private context"}]\n```' },
            { type: "text", text: "Location (untrusted metadata):" },
            { type: "text", text: '```json\n{"latitude":37.77,"longitude":-122.42}\n```' },
            { type: "text", text: "WhatsApp contact (untrusted metadata):" },
            { type: "text", text: '```json\n{"phone":"+15551234567"}\n```' },
            { type: "text", text: "Summarize the roof inspection notes" },
          ],
        },
      },
    ]);

    await handler(
      { sessionId: "metadata", messageCount: 1, reason: "idle", sessionFile },
      { agentId: "aurelius", sessionId: "metadata" },
    );

    const stream = await readFile(
      path.join(workspace, "state", "session-digests", "session-digests.jsonl"),
      "utf8",
    );
    const intent = JSON.parse(stream.trim()).intent;
    expect(intent).toBe("Summarize the roof inspection notes");
    expect(intent).not.toContain("msg-abc");
    expect(intent).not.toContain("user-1");
    expect(intent).not.toContain("private context");
    expect(intent).not.toContain("+15551234567");
  });

  test("captures timestamped user text after inbound metadata envelopes", async () => {
    const { workspace, handler } = await setupPlugin();
    const sessionFile = await writeTranscript([
      {
        type: "message",
        id: "m1",
        timestamp: "2026-06-04T01:00:01.000Z",
        message: {
          role: "user",
          content: [
            { type: "input_text", text: "Sender (untrusted metadata):" },
            { type: "input_text", text: '```json\n{"label":"openclaw-control-ui"}\n```' },
            { type: "input_text", text: "[Thu 2026-03-26 16:29 GMT] Check the gutters" },
          ],
        },
      },
    ]);

    await handler(
      { sessionId: "metadata-timestamp", messageCount: 1, reason: "idle", sessionFile },
      { agentId: "aurelius", sessionId: "metadata-timestamp" },
    );

    const stream = await readFile(
      path.join(workspace, "state", "session-digests", "session-digests.jsonl"),
      "utf8",
    );
    expect(JSON.parse(stream.trim()).intent).toBe("Check the gutters");
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

  test("rejects digestDir paths that escape the agent workspace", async () => {
    const escapedDirName = `session-digest-escaped-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const { workspace, handler, logger } = await setupPlugin({
      digestDir: `../${escapedDirName}`,
    });
    await expect(
      handler(
        { sessionId: "escape", messageCount: 1, reason: "idle" },
        { agentId: "aurelius", sessionId: "escape" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      readFile(path.join(path.dirname(workspace), escapedDirName, "session-digests.jsonl"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("digestDir must stay within the agent workspace"),
    );
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
