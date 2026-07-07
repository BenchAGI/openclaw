// Gateway assistant-event text extractor.
// Normalizes provider stream event shapes into a display text delta.
import type { AgentEventPayload } from "../infra/agent-events.js";

// Agent stream events may carry assistant text as either incremental delta or
// full text, depending on provider/runtime. Gateway display paths normalize the
// two shapes here before broadcasting.
/** Extracts the assistant-visible text delta from an agent event payload. */
export function resolveAssistantStreamDeltaText(evt: AgentEventPayload): string {
  const delta = evt.data.delta;
  const text = evt.data.text;
  return typeof delta === "string" ? delta : typeof text === "string" ? text : "";
}

// Claude CLI stream-json envelope frame types. The ultracode backend can surface
// its full `--output-format stream-json` stdout (session hooks, stream_event,
// tool_use/result) as assistant content instead of clean text. We recognize a
// leaked blob by these without misfiring on ordinary prose (which never opens
// as one of these frames).
const CLAUDE_CLI_FRAME_TYPES = new Set<string>([
  "system",
  "stream_event",
  "assistant",
  "user",
  "result",
  "message_start",
  "message_stop",
  "message_delta",
  "content_block_start",
  "content_block_stop",
  "content_block_delta",
  "tool_use",
  "tool_result",
]);

function looksLikeClaudeStreamJson(text: string): boolean {
  const s = text.replace(/^\s+/, "");
  if (!s.startsWith("{")) {
    return false;
  }
  const nl = s.indexOf("\n");
  const first = nl >= 0 ? s.slice(0, nl) : s;
  try {
    const obj = JSON.parse(first) as { type?: unknown };
    return (
      typeof obj === "object" &&
      obj !== null &&
      typeof obj.type === "string" &&
      CLAUDE_CLI_FRAME_TYPES.has(obj.type)
    );
  } catch {
    return false;
  }
}

/**
 * Salvage clean assistant text from a leaked Claude CLI stream-json blob.
 * Concatenates `stream_event → content_block_delta → text_delta.text` (the
 * canonical streamed answer); falls back to the final `result.result`, then to
 * the original content so a real answer is never dropped. Returns ordinary text
 * unchanged (the common case) — only a recognized raw blob is rewritten.
 */
export function salvageClaudeStreamJsonText(content: string): string {
  if (!looksLikeClaudeStreamJson(content)) {
    return content;
  }
  const parts: string[] = [];
  let resultText = "";
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let fr: {
      type?: unknown;
      event?: { type?: unknown; delta?: { type?: unknown; text?: unknown } };
      result?: unknown;
    };
    try {
      fr = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!fr || typeof fr !== "object") {
      continue;
    }
    if (
      fr.type === "stream_event" &&
      fr.event?.type === "content_block_delta" &&
      fr.event.delta?.type === "text_delta" &&
      typeof fr.event.delta.text === "string"
    ) {
      parts.push(fr.event.delta.text);
    } else if (fr.type === "result" && typeof fr.result === "string") {
      resultText = fr.result;
    }
  }
  const streamed = parts.join("");
  if (streamed.trim()) {
    return streamed;
  }
  if (resultText.trim()) {
    return resultText;
  }
  return content;
}

/**
 * Extract a native AskUserQuestion tool call buried in a leaked Claude CLI
 * stream-json blob (ultracode turns dump the whole stream as assistant content,
 * bypassing the tool tracker). Returns its tool-call id + raw input args so the
 * gateway can bridge it into an ask_choice card. Null when none is present.
 */
export function extractAskUserQuestionFromClaudeStreamJson(
  content: string,
): { toolCallId: string; args: Record<string, unknown> } | null {
  if (!looksLikeClaudeStreamJson(content)) {
    return null;
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let fr: { type?: unknown; message?: unknown };
    try {
      fr = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!fr || typeof fr !== "object" || fr.type !== "assistant") {
      continue;
    }
    const message = fr.message;
    const blocks =
      message && typeof message === "object" ? (message as { content?: unknown }).content : null;
    if (!Array.isArray(blocks)) {
      continue;
    }
    for (const block of blocks) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use" &&
        (block as { name?: unknown }).name === "AskUserQuestion"
      ) {
        const input = (block as { input?: unknown }).input;
        if (input && typeof input === "object" && !Array.isArray(input)) {
          const id = (block as { id?: unknown }).id;
          return {
            toolCallId: typeof id === "string" ? id : "",
            args: input as Record<string, unknown>,
          };
        }
      }
    }
  }
  return null;
}

export function isReplaceableAssistantStreamEvent(evt: AgentEventPayload): boolean {
  return evt.data.replaceable === true;
}

export function resolveAssistantStreamSnapshotText(evt: AgentEventPayload): string {
  const text = evt.data.text;
  if (typeof text === "string") {
    return text;
  }
  return resolveAssistantStreamDeltaText(evt);
}
