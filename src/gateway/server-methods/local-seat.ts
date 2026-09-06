// Local seat bridge persists desktop CLI captures and optionally wakes the selected agent.
import { mkdir, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  type LocalSeatCaptureParams,
  validateLocalSeatCaptureParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveStateDir } from "../../config/paths.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

const SAFE_SEGMENT_RE = /[^a-z0-9._-]+/gi;

// Upstream 2026.9.2 dropped nodes.helpers.respondInvalidParams; keep the same shape here.
function respondInvalidParams(params: {
  respond: RespondFn;
  method: string;
  validator: { errors?: unknown };
}) {
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${params.method} params: ${formatValidationErrors(params.validator.errors as never)}`,
    ),
  );
}

function safeSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(SAFE_SEGMENT_RE, "-")
    .replace(/^-+|-+$/g, "");
  return normalized && normalized !== "." && normalized !== ".." ? normalized : "unknown";
}

function resolveCaptureDate(ts?: string): string {
  const date = ts ? new Date(ts) : new Date();
  const safeDate = Number.isFinite(date.getTime()) ? date : new Date();
  return safeDate.toISOString().slice(0, 10);
}

function resolveCapturePath(params: LocalSeatCaptureParams): string {
  return path.join(
    resolveStateDir(),
    "local-seat-captures",
    safeSegment(params.agentId),
    `${resolveCaptureDate(params.ts)}.jsonl`,
  );
}

function boundedText(value: string | undefined, limit: number): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}\n[truncated]` : trimmed;
}

function renderSystemEvent(params: LocalSeatCaptureParams): string | undefined {
  const body = boundedText(params.summary, 4_000) ?? boundedText(params.text, 8_000);
  if (!body) {
    return undefined;
  }
  const cwd = boundedText(params.cwd, 500);
  const context = [
    `seat=${params.seatKind}`,
    `event=${params.event}`,
    `session=${safeSegment(params.seatSessionId)}`,
    cwd ? `cwd=${cwd}` : undefined,
  ].filter(Boolean);
  return `Local seat capture (untrusted context): ${context.join(" ")}\n${body}`;
}

function defaultWakeForEvent(event: LocalSeatCaptureParams["event"]): boolean {
  return event === "user_prompt" || event === "summary";
}

/** Gateway handlers for local desktop Claude/Codex seat capture. */
export const localSeatHandlers: GatewayRequestHandlers = {
  "local-seat.capture": async ({ params, respond, context }) => {
    if (!validateLocalSeatCaptureParams(params)) {
      respondInvalidParams({
        respond,
        method: "local-seat.capture",
        validator: validateLocalSeatCaptureParams,
      });
      return;
    }

    const captureParams = { ...params, agentId: normalizeAgentId(params.agentId) };
    const capturePath = resolveCapturePath(captureParams);
    const receivedAt = new Date().toISOString();
    const record = {
      ...captureParams,
      host: captureParams.host ?? os.hostname(),
      platform: captureParams.platform ?? process.platform,
      receivedAt,
    };

    try {
      await mkdir(path.dirname(capturePath), { recursive: true });
      await appendFile(capturePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      return;
    }

    let queued = false;
    if (captureParams.wake ?? defaultWakeForEvent(captureParams.event)) {
      const text = renderSystemEvent(captureParams);
      if (text) {
        const cfg = context.getRuntimeConfig();
        const sessionKey = resolveAgentMainSessionKey({ cfg, agentId: captureParams.agentId });
        queued = enqueueSystemEvent(text, {
          sessionKey,
          contextKey: `local-seat:${captureParams.seatKind}:${captureParams.seatSessionId}:${captureParams.event}`,
        });
      }
    }

    respond(true, { ok: true, capturePath, queued }, undefined);
  },
};
