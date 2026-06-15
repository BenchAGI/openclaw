// Speech-to-text dictation for the chat composer.
//
// Wraps the browser SpeechRecognition API so a user can click the mic button,
// speak, and watch their words stream into the composer draft as text — the
// same "click a microphone and talk" flow the legacy Aurelius app had. This is
// dictation-into-the-textbox, distinct from the real-time-talk feature (a live
// two-way voice call). No backend, no API key: the browser does the transcription.
//
// Browser support: Chromium (Chrome/Edge) and Safari expose this under
// `webkitSpeechRecognition`; standards-track `SpeechRecognition` is also probed.
// Firefox does not implement it — callers should check `isDictationSupported()`.

// Minimal structural typings — lib.dom.d.ts does not ship SpeechRecognition.
interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
}

interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  readonly [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike {
  readonly error: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  addEventListener(type: "result", listener: (event: SpeechRecognitionEventLike) => void): void;
  addEventListener(type: "error", listener: (event: SpeechRecognitionErrorEventLike) => void): void;
  addEventListener(type: "end" | "start", listener: () => void): void;
  removeEventListener(type: "result", listener: (event: SpeechRecognitionEventLike) => void): void;
  removeEventListener(
    type: "error",
    listener: (event: SpeechRecognitionErrorEventLike) => void,
  ): void;
  removeEventListener(type: "end" | "start", listener: () => void): void;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;
interface RecognitionListeners {
  start: () => void;
  result: (event: SpeechRecognitionEventLike) => void;
  error: (event: SpeechRecognitionErrorEventLike) => void;
  end: () => void;
}

function getRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") {
    return null;
  }
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** True when the browser can perform speech-to-text dictation. */
export function isDictationSupported(): boolean {
  return getRecognitionCtor() !== null;
}

export interface DictationHandlers {
  /**
   * Called whenever the transcript updates. `dictated` is the full text spoken
   * during this dictation session so far (finalized text plus the current
   * interim guess). The host composes it onto the pre-dictation draft.
   */
  onText: (dictated: string) => void;
  /** Recognition actually started listening. */
  onStart?: () => void;
  /**
   * Progress within an active session. "recording" = capturing audio,
   * "transcribing" = audio captured, awaiting text (Whisper engine only).
   */
  onStatus?: (status: "recording" | "transcribing") => void;
  /** Recognition terminally ended (user stopped, or a hard error). */
  onEnd?: () => void;
  /** A surfaced error (permission denied, unsupported, etc.). */
  onError?: (message: string) => void;
}

/**
 * Common shape every dictation engine exposes, so the composer can drive the
 * browser Web Speech engine or the gateway Whisper engine interchangeably.
 */
export interface DictationEngine {
  start(): void;
  stop(): void;
  dispose(): void;
  readonly isActive: boolean;
}

// Errors that fire routinely and should not be surfaced to the user.
const BENIGN_ERRORS = new Set(["no-speech", "aborted"]);

/**
 * Drives a single composer's dictation. Reusable across start/stop cycles:
 * each `start()` begins a fresh transcript, accumulating finalized segments
 * while emitting live interim results.
 */
export class DictationController implements DictationEngine {
  private recognition: SpeechRecognitionLike | null = null;
  private finalText = "";
  private active = false;
  private recognitionListeners: RecognitionListeners | null = null;
  private readonly handlers: DictationHandlers;
  private readonly lang: string;

  constructor(handlers: DictationHandlers, opts?: { lang?: string }) {
    this.handlers = handlers;
    this.lang =
      opts?.lang ??
      (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en-US");
  }

  get supported(): boolean {
    return isDictationSupported();
  }

  get isActive(): boolean {
    return this.active;
  }

  start(): void {
    if (this.active) {
      return;
    }
    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.handlers.onError?.("Dictation isn't supported in this browser.");
      return;
    }

    this.detachRecognitionListeners();
    const recognition = new Ctor();
    recognition.lang = this.lang;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    this.finalText = "";
    this.active = true;

    const onStart = () => {
      this.handlers.onStart?.();
    };

    const onResult = (event: SpeechRecognitionEventLike) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          this.finalText += transcript;
        } else {
          interim += transcript;
        }
      }
      this.handlers.onText(normalize(this.finalText + interim));
    };

    const onError = (event: SpeechRecognitionErrorEventLike) => {
      if (BENIGN_ERRORS.has(event.error)) {
        return;
      }
      // Stop auto-restart and surface a friendly message.
      this.active = false;
      this.handlers.onError?.(describeError(event.error));
    };

    const onEnd = () => {
      if (this.active) {
        // Browsers end recognition after a stretch of silence even in
        // `continuous` mode; restart so dictation stays live until the user
        // explicitly stops. Finalized text persists across the restart.
        try {
          recognition.start();
          return;
        } catch {
          this.active = false;
        }
      }
      this.handlers.onEnd?.();
    };
    this.recognitionListeners = { start: onStart, result: onResult, error: onError, end: onEnd };
    recognition.addEventListener("start", onStart);
    recognition.addEventListener("result", onResult);
    recognition.addEventListener("error", onError);
    recognition.addEventListener("end", onEnd);

    try {
      recognition.start();
      this.recognition = recognition;
    } catch (error) {
      this.active = false;
      this.recognition = null;
      this.detachRecognitionListeners(recognition);
      this.handlers.onError?.(
        error instanceof Error ? error.message : "Could not start dictation.",
      );
    }
  }

  /** Graceful stop: flushes any final result, then ends without restarting. */
  stop(): void {
    this.active = false;
    try {
      this.recognition?.stop();
    } catch {
      // ignore — already stopped
    }
  }

  /** Hard teardown for component disconnect. */
  dispose(): void {
    this.active = false;
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      this.detachRecognitionListeners(recognition);
      try {
        recognition.abort();
      } catch {
        // ignore
      }
    }
  }

  private detachRecognitionListeners(recognition = this.recognition): void {
    const listeners = this.recognitionListeners;
    if (!recognition || !listeners) {
      return;
    }
    recognition.removeEventListener("start", listeners.start);
    recognition.removeEventListener("result", listeners.result);
    recognition.removeEventListener("error", listeners.error);
    recognition.removeEventListener("end", listeners.end);
    this.recognitionListeners = null;
  }
}

function normalize(text: string): string {
  // Collapse the double spaces that can appear where interim/final segments meet.
  return text.replace(/\s{2,}/g, " ").replace(/^\s+/, "");
}

function describeError(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone access was denied. Enable it to use dictation.";
    case "audio-capture":
      return "No microphone was found.";
    case "network":
      return "Dictation failed: network error reaching the speech service.";
    default:
      return `Dictation error: ${code}`;
  }
}
