// Gateway-backed speech-to-text dictation for the chat composer.
//
// Records a mic clip with MediaRecorder, ships the bytes (base64) to the
// gateway `audio.transcribe` method, and feeds the returned transcript into the
// composer draft. This is the Whisper engine: capture in the browser, transcribe
// server-side via the configured media-understanding audio model (e.g. whisper-1).
//
// Unlike the browser Web Speech engine ([[dictation.ts]]), transcription happens
// once on stop, so the controller reports a "transcribing" status between the
// user releasing the mic and the text arriving.
import type { DictationEngine, DictationHandlers } from "./dictation.ts";

/** Minimal shape of the gateway client this controller needs. */
export interface TranscribeClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
}

const MIN_RECORDING_MS = 250;
const MAX_RECORDING_MS = 60_000;

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

/** True when the browser can capture mic audio as a recorded clip. */
export function isMediaCaptureSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia &&
    typeof MediaRecorder !== "undefined"
  );
}

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return undefined;
  }
  for (const candidate of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read audio."));
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(blob);
  });
}

function describeMicError(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Microphone access was denied. Enable it to use dictation.";
    case "NotFoundError":
      return "No microphone was found.";
    case "NotReadableError":
      return "The microphone is already in use by another app.";
    default:
      return error instanceof Error ? error.message : "Could not start the microphone.";
  }
}

function describeTranscribeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message ? `Transcription failed: ${message}` : "Transcription failed.";
}

/** Records a clip and transcribes it through the gateway Whisper pipeline. */
export class GatewayDictationController implements DictationEngine {
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private active = false;
  private ending = false;
  private disposed = false;
  private startedAt = 0;
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly client: TranscribeClient;
  private readonly handlers: DictationHandlers;
  private readonly lang?: string;

  constructor(client: TranscribeClient, handlers: DictationHandlers, opts?: { lang?: string }) {
    this.client = client;
    this.handlers = handlers;
    this.lang =
      opts?.lang ??
      (typeof navigator !== "undefined" && navigator.language ? navigator.language : undefined);
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) {
      return;
    }
    if (!isMediaCaptureSupported()) {
      this.handlers.onError?.("Voice recording isn't supported in this browser.");
      return;
    }
    this.active = true;
    void this.begin();
  }

  private async begin(): Promise<void> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      this.active = false;
      this.handlers.onError?.(describeMicError(error));
      return;
    }
    // The user may have toggled off during the permission prompt.
    if (!this.active) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    this.stream = stream;

    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    this.chunks = [];
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      void this.finish(recorder.mimeType || mimeType || "audio/webm");
    };
    recorder.onerror = () => {
      this.handlers.onError?.("Recording failed.");
      this.finalizeIdle();
    };
    this.recorder = recorder;
    this.startedAt = Date.now();
    recorder.start();
    this.handlers.onStart?.();
    // Safety cap so a forgotten recording can't run forever.
    this.maxTimer = setTimeout(() => {
      if (this.active) {
        this.stop();
      }
    }, MAX_RECORDING_MS);
  }

  stop(): void {
    if (!this.active || this.ending) {
      return;
    }
    // Stay active through transcription; finalizeIdle() clears it. The `ending`
    // guard makes a second click during stop/transcribe a no-op.
    this.ending = true;
    this.clearTimer();
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") {
      try {
        recorder.stop();
      } catch {
        this.finalizeIdle();
      }
    } else {
      this.finalizeIdle();
    }
  }

  private async finish(mimeType: string): Promise<void> {
    this.stopTracks();
    const blob = new Blob(this.chunks, { type: mimeType });
    this.chunks = [];
    const elapsed = Date.now() - this.startedAt;
    if (this.disposed || blob.size === 0 || elapsed < MIN_RECORDING_MS) {
      this.finalizeIdle();
      return;
    }
    this.handlers.onStatus?.("transcribing");
    try {
      const audioBase64 = await blobToBase64(blob);
      const response = await this.client.request<{ transcript?: string }>("audio.transcribe", {
        audioBase64,
        mimeType,
        language: this.lang,
      });
      // The controller may have been disposed (component disconnected) while the
      // transcription was in flight — never write stale text into the composer.
      if (this.disposed) {
        return;
      }
      const transcript = typeof response?.transcript === "string" ? response.transcript.trim() : "";
      if (transcript) {
        this.handlers.onText(transcript);
      }
    } catch (error) {
      if (!this.disposed) {
        this.handlers.onError?.(describeTranscribeError(error));
      }
    } finally {
      this.finalizeIdle();
    }
  }

  private finalizeIdle(): void {
    this.active = false;
    this.ending = false;
    this.clearTimer();
    this.recorder = null;
    if (!this.disposed) {
      this.handlers.onEnd?.();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.active = false;
    this.ending = false;
    this.clearTimer();
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.onerror = null;
      if (recorder.state !== "inactive") {
        try {
          recorder.stop();
        } catch {
          // ignore
        }
      }
    }
    this.stopTracks();
    this.chunks = [];
  }

  private stopTracks(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
  }

  private clearTimer(): void {
    if (this.maxTimer !== null) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
  }
}
