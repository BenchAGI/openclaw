/**
 * OpenClaw Session Digest Plugin
 *
 * Emits one structured SessionDigest JSON line into the owning agent's
 * workspace (`<workspace>/state/session-digests/session-digests.jsonl`, plus a
 * `by-session/<sessionId>.json` snapshot) whenever a gateway session ends —
 * Slack DMs/channels, web bridge, and one-shot CLI runs alike.
 *
 * The digest stream is the Capture plane of a workspace-local
 * Capture -> Reconcile -> Assemble memory loop: a workspace-side reconciler
 * ingests the stream and folds session intent into durable memory. This plugin
 * intentionally emits NO goal classification — classification belongs to the
 * workspace reconciler, keeping a single source of truth for goal keywords.
 *
 * Notes:
 * - `session_end` fires on session transition/reset/idle/daily/shutdown, not
 *   synchronously at the end of every one-shot turn; one-shot sessions are
 *   captured lazily by the idle/daily reapers or the shutdown drain.
 * - `reason: "compaction"` is skipped — the conversation continues afterwards.
 * - The handler runs inside the shutdown drain's bounded time budget, so the
 *   write path is a single small append plus one bounded head-read of the
 *   transcript; lines are well under PIPE_BUF, so O_APPEND appends are atomic
 *   without a lock.
 */
import { Buffer } from "node:buffer";
import { appendFile, mkdir, open, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  definePluginEntry,
  redactSensitiveText,
  resolveAgentWorkspaceDir,
  resolveLivePluginConfigObject,
  type OpenClawConfig,
  type OpenClawPluginApi,
} from "./api.js";

const DIGEST_VERSION = 1;
const DEFAULT_DIGEST_DIR = "state/session-digests";
const INTENT_READ_BYTES = 64 * 1024;
const INTENT_MAX_CHARS = 240;
const WINDOWS_ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/u;

const META_PROMPT_PATTERN =
  /^(<command-name>|<command-message>|<local-command|<system-reminder>|Caveat:|\[Request interrupted|Continue this conversation|Read HEARTBEAT\.md|\[[A-Z][a-z]{2} \d{4}-\d{2}-\d{2})/;
const TEXT_CONTENT_BLOCK_TYPES = new Set(["text", "input_text", "output_text", "user_text"]);
const LEADING_TIMESTAMP_PREFIX_RE = /^\[[A-Za-z]{3} \d{4}-\d{2}-\d{2} \d{2}:\d{2}[^\]]*\] */;
const INBOUND_METADATA_SENTINELS = new Set([
  "Conversation info (untrusted metadata):",
  "Sender (untrusted metadata):",
  "Thread starter (untrusted, for context):",
  "Reply chain of current user message (untrusted, nearest first):",
  "Reply target of current user message (untrusted, for context):",
  "Forwarded message context (untrusted metadata):",
  "Location (untrusted metadata):",
  "Chat history since last reply (untrusted, for context):",
]);
const DYNAMIC_UNTRUSTED_METADATA_SENTINEL_RE = /^.{1,120} \(untrusted metadata\):$/u;

type SessionDigestConfig = {
  digestDir: string;
  captureIntent: boolean;
};

export default definePluginEntry({
  id: "session-digest",
  name: "Session Digest",
  description: "Emit a structured SessionDigest into the agent workspace when a session ends",
  register(api) {
    api.on("session_end", async (event, ctx) => {
      try {
        if (!event?.sessionId) {
          return;
        }
        if (event.messageCount === 0) {
          return; // Empty rotations carry no intent worth capturing.
        }
        if (event.reason === "compaction") {
          return; // The conversation continues after compaction; the real end fires later.
        }
        const agentId = ctx.agentId?.trim();
        if (!agentId) {
          api.logger.debug?.(
            `session-digest: skipping ${event.sessionId} (no agentId in hook context)`,
          );
          return;
        }
        const runtimeConfig = (api.runtime.config?.current?.() ?? api.config) as OpenClawConfig;
        const config = resolveSessionDigestConfig(api, runtimeConfig);
        const workspaceDir = resolveAgentWorkspaceDir(runtimeConfig, agentId);
        if (!workspaceDir) {
          return;
        }

        const endedAt = new Date();
        const startedAt =
          typeof event.durationMs === "number" && event.durationMs > 0
            ? new Date(endedAt.getTime() - event.durationMs)
            : null;
        const intent = config.captureIntent ? await extractIntent(event.sessionFile) : "";
        const sessionKey = ctx.sessionKey ?? event.sessionKey;

        const digest = {
          version: DIGEST_VERSION,
          digestId: newDigestId(),
          sessionId: event.sessionId,
          agentId,
          surface: "openclaw-gateway",
          workspace: workspaceDir,
          startedAt: startedAt ? startedAt.toISOString() : null,
          endedAt: endedAt.toISOString(),
          capturedAt: endedAt.toISOString(),
          intent,
          decisions: [],
          outcomes: [],
          openLoops: [],
          entities: [
            `reason:${event.reason ?? "unknown"}`,
            ...(sessionKey ? [`sessionKey:${redactSensitiveText(sessionKey)}`] : []),
          ],
          artifactLinks: [],
          promotionHint: "review",
          productSignal: { present: false, summary: "" },
          sourceRefs: event.sessionFile ? [event.sessionFile] : [],
          privacy: "local-private",
          notes: `Auto-captured by session-digest plugin (${event.messageCount} message(s)${
            event.transcriptArchived ? "; transcript archived" : ""
          }).`,
        };

        const outDir = path.join(workspaceDir, config.digestDir);
        const bySessionDir = path.join(outDir, "by-session");
        await mkdir(bySessionDir, { recursive: true, mode: 0o700 });
        await appendFile(
          path.join(outDir, "session-digests.jsonl"),
          `${JSON.stringify(digest)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        await writeFile(
          path.join(bySessionDir, `${safeFileName(event.sessionId)}.json`),
          `${JSON.stringify(digest, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        api.logger.info(
          `session-digest: captured ${event.sessionId} (reason: ${event.reason ?? "unknown"})`,
        );
      } catch (err) {
        api.logger.warn(`session-digest: capture failed: ${String(err)}`);
      }
    });
  },
});

function resolveSessionDigestConfig(
  api: OpenClawPluginApi,
  runtimeConfig: OpenClawConfig,
): SessionDigestConfig {
  const rawConfig = resolveLivePluginConfigObject(
    () => runtimeConfig,
    "session-digest",
    api.pluginConfig,
  );
  return normalizeSessionDigestConfig(rawConfig);
}

function normalizeSessionDigestConfig(rawConfig?: Record<string, unknown>): SessionDigestConfig {
  return {
    digestDir: normalizeDigestDir(rawConfig?.digestDir),
    captureIntent: rawConfig?.captureIntent !== false,
  };
}

function normalizeDigestDir(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_DIGEST_DIR;
  if (path.isAbsolute(raw) || WINDOWS_ABSOLUTE_PATH.test(raw)) {
    throw new Error("session-digest digestDir must be relative to the agent workspace");
  }
  const parts = raw.split(/[\\/]+/u).filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) {
    throw new Error("session-digest digestDir must stay within the agent workspace");
  }
  return parts.join(path.sep);
}

/**
 * Extract the first non-meta user message from the head of a session
 * transcript. Reads at most INTENT_READ_BYTES so the handler stays fast inside
 * the shutdown drain budget; a truncated final line simply fails JSON.parse
 * and is skipped.
 */
async function extractIntent(sessionFile?: string): Promise<string> {
  if (!sessionFile) {
    return "";
  }
  let handle;
  try {
    handle = await open(sessionFile, "r");
  } catch {
    return ""; // Missing or already-archived transcript: emit a stub digest.
  }
  try {
    const buffer = Buffer.alloc(INTENT_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    for (const line of text.split("\n")) {
      if (!line.trim() || !line.includes('"role"')) {
        continue;
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const message = (record as { message?: { role?: string; content?: unknown } }).message;
      if (!message || message.role !== "user") {
        continue;
      }
      const textBlock = stripInboundMetadataBlocks(extractTextContent(message.content));
      const cleaned = textBlock.replace(/\s+/g, " ").trim();
      if (!cleaned || META_PROMPT_PATTERN.test(cleaned)) {
        continue;
      }
      return truncate(redactSensitiveText(cleaned), INTENT_MAX_CHARS);
    }
    return "";
  } finally {
    await handle.close();
  }
}

function stripInboundMetadataBlocks(text: string): string {
  if (!text) {
    return text;
  }
  const lines = text.replace(LEADING_TIMESTAMP_PREFIX_RE, "").split(/\r?\n/u);
  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isInboundMetadataSentinel(line)) {
      result.push(line);
      continue;
    }

    // Mirrors the OpenClaw inbound metadata contract: sentinel line, fenced JSON,
    // then user-visible text. Dynamic labels cover structured context entries.
    if (lines[index + 1]?.trim() !== "```json") {
      result.push(line);
      continue;
    }
    index += 2;
    while (index < lines.length && lines[index]?.trim() !== "```") {
      index += 1;
    }
    while (index + 1 < lines.length && lines[index + 1]?.trim() === "") {
      index += 1;
    }
  }
  return result.join("\n").trim().replace(LEADING_TIMESTAMP_PREFIX_RE, "").trim();
}

function isInboundMetadataSentinel(line: string): boolean {
  const trimmed = line.trim();
  return (
    INBOUND_METADATA_SENTINELS.has(trimmed) || DYNAMIC_UNTRUSTED_METADATA_SENTINEL_RE.test(trimmed)
  );
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const typedBlock = block as { text?: unknown; type?: unknown };
      const type = typeof typedBlock.type === "string" ? typedBlock.type.toLowerCase() : "text";
      return TEXT_CONTENT_BLOCK_TYPES.has(type) && typeof typedBlock.text === "string"
        ? typedBlock.text
        : "";
    })
    .join("\n");
}

function newDigestId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, "")
    .slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `dg-${stamp}-${rand}`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180);
}

function truncate(text: string, maxChars: number): string {
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) {
    return cleaned;
  }
  return `${cleaned.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}
