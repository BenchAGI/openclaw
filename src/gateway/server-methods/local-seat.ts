import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { ErrorCodes, errorShape, validateLocalSeatCaptureParams } from "../protocol/index.js";
import { assertValidParams } from "./validation.js";
import type { GatewayRequestHandlers } from "./types.js";

const MAX_SUMMARY_CHARS = 4_000;
const MAX_TEXT_CHARS = 12_000;
const MAX_EVENT_TEXT_CHARS = 700;

function truncate(value: string | undefined, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars - 3)}...`;
}

function safePathSegment(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "unknown";
}

function captureDate(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function buildCaptureText(params: {
  agentId: string;
  seatKind: string;
  event: string;
  summary?: string;
  text?: string;
}): string {
  const subject = params.summary ?? params.text ?? "";
  const suffix = truncate(subject.replace(/\s+/g, " "), MAX_EVENT_TEXT_CHARS);
  const label = params.seatKind === "codex-cli" ? "Codex CLI" : "Claude Code";
  return [
    `Local ${label} seat capture`,
    `agent=${params.agentId}`,
    `event=${params.event}`,
    suffix ? `summary=${suffix}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export const localSeatHandlers: GatewayRequestHandlers = {
  "local-seat.capture": ({ params, respond }) => {
    if (!assertValidParams(params, validateLocalSeatCaptureParams, "local-seat.capture", respond)) {
      return;
    }

    const capturedAt = params.ts ?? Date.now();
    const agentId = params.agentId.trim();
    const seatSessionId = params.seatSessionId.trim();
    const safeAgentId = safePathSegment(agentId);
    const date = captureDate(capturedAt);
    const captureDir = path.join(resolveStateDir(), "local-seat-captures", safeAgentId);
    const capturePath = path.join(captureDir, `${date}.jsonl`);
    const entry = {
      schemaVersion: 1,
      capturedAt,
      agentId,
      seatKind: params.seatKind,
      seatSessionId,
      event: params.event,
      summary: truncate(params.summary, MAX_SUMMARY_CHARS),
      text: truncate(params.text, MAX_TEXT_CHARS),
      cwd: truncate(params.cwd, 2_000),
      host: truncate(params.host, 255),
      platform: truncate(params.platform, 120),
      launcherVersion: truncate(params.launcherVersion, 120),
      providerVersion: truncate(params.providerVersion, 120),
      source: truncate(params.source, 120),
    };

    try {
      fs.mkdirSync(captureDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(capturePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to persist local-seat capture: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      return;
    }

    let queued = false;
    if (params.wake !== false) {
      queued = enqueueSystemEvent(
        buildCaptureText({
          agentId,
          seatKind: params.seatKind,
          event: params.event,
          summary: entry.summary,
          text: entry.text,
        }),
        {
          sessionKey: resolveAgentMainSessionKey({ cfg: loadConfig(), agentId }),
          contextKey: `local-seat:${safeAgentId}:${safePathSegment(seatSessionId)}:${params.event}`,
          trusted: false,
        },
      );
    }

    respond(true, { ok: true, capturePath, queued }, undefined);
  },
};
