// Gateway RPC handler for one-shot audio transcription (speech-to-text).
//
// Accepts a base64-encoded audio clip (recorded by the web Console mic button)
// and returns the transcript by running the configured media-understanding
// audio pipeline — e.g. whisper-1 via an OpenAI-compatible provider, or a local
// whisper.cpp server. This is the inverse of the `tts.convert` media method:
// audio in, text out, no long-lived Talk session.
//
// Binary travels as base64 in JSON (the gateway's only wire format). We stage
// the clip to a temp file under the sanctioned OpenClaw tmp dir because the
// media-understanding runner consumes a file path, then always clean it up.
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { transcribeAudioFile } from "../../media-understanding/runtime.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";

// 5 MB of binary audio (matches the chat-attachment per-file cap). base64
// inflates ~4/3, so bound the encoded string a little above that.
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;
const MAX_AUDIO_BASE64_CHARS = Math.ceil((MAX_AUDIO_BYTES * 4) / 3) + 16;

const MIME_EXTENSIONS: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};

function extensionForMime(mimeType: string): string {
  const base = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return MIME_EXTENSIONS[base] ?? "webm";
}

/** Gateway request handler for one-shot speech-to-text. */
export const audioHandlers: GatewayRequestHandlers = {
  "audio.transcribe": async ({ params, respond, context }) => {
    const audioBase64 = normalizeOptionalString(params.audioBase64) ?? "";
    if (!audioBase64) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "audio.transcribe requires audioBase64"),
      );
      return;
    }
    if (audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `audio clip too large (max ${MAX_AUDIO_BYTES} bytes)`,
        ),
      );
      return;
    }
    const mimeType = normalizeOptionalString(params.mimeType) ?? "audio/webm";
    const language = normalizeOptionalString(params.language);

    const buffer = Buffer.from(audioBase64, "base64");
    if (buffer.byteLength === 0) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "audio clip is empty"));
      return;
    }

    const tmpDir = path.join(resolvePreferredOpenClawTmpDir(), "openclaw-stt");
    const filePath = path.join(tmpDir, `clip-${randomUUID()}.${extensionForMime(mimeType)}`);
    try {
      await mkdir(tmpDir, { recursive: true });
      await writeFile(filePath, buffer);
      const cfg = context.getRuntimeConfig();
      const result = await transcribeAudioFile({ filePath, cfg, language });
      const transcript = result.text?.trim();
      if (transcript) {
        respond(true, { transcript });
        return;
      }
      // No text + no provider attempt means transcription isn't configured.
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          "No transcript produced. Configure an audio transcription model under tools.media.audio.models (e.g. whisper-1 via an OpenAI-compatible provider, or a local whisper.cpp server).",
        ),
      );
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
    } finally {
      await rm(filePath, { force: true }).catch(() => {});
    }
  },
};
