import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationController, isDictationSupported } from "./dictation.ts";

interface FakeResult {
  isFinal: boolean;
  length: number;
  0: { transcript: string };
}

interface FakeRecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<FakeResult>;
}

interface FakeRecognitionErrorEvent {
  error: string;
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  startCount = 0;
  stopCount = 0;
  abortCount = 0;
  private readonly resultListeners = new Set<(event: FakeRecognitionResultEvent) => void>();
  private readonly errorListeners = new Set<(event: FakeRecognitionErrorEvent) => void>();
  private readonly startListeners = new Set<() => void>();
  private readonly endListeners = new Set<() => void>();

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.startCount++;
    this.emitStart();
  }

  stop(): void {
    this.stopCount++;
    this.emitEnd();
  }

  abort(): void {
    this.abortCount++;
  }

  addEventListener(type: "result", listener: (event: FakeRecognitionResultEvent) => void): void;
  addEventListener(type: "error", listener: (event: FakeRecognitionErrorEvent) => void): void;
  addEventListener(type: "end" | "start", listener: () => void): void;
  addEventListener(
    type: "end" | "error" | "result" | "start",
    listener:
      | ((event: FakeRecognitionErrorEvent) => void)
      | ((event: FakeRecognitionResultEvent) => void)
      | (() => void),
  ): void {
    switch (type) {
      case "result":
        this.resultListeners.add(listener as (event: FakeRecognitionResultEvent) => void);
        break;
      case "error":
        this.errorListeners.add(listener as (event: FakeRecognitionErrorEvent) => void);
        break;
      case "start":
        this.startListeners.add(listener as () => void);
        break;
      case "end":
        this.endListeners.add(listener as () => void);
        break;
    }
  }

  removeEventListener(type: "result", listener: (event: FakeRecognitionResultEvent) => void): void;
  removeEventListener(type: "error", listener: (event: FakeRecognitionErrorEvent) => void): void;
  removeEventListener(type: "end" | "start", listener: () => void): void;
  removeEventListener(
    type: "end" | "error" | "result" | "start",
    listener:
      | ((event: FakeRecognitionErrorEvent) => void)
      | ((event: FakeRecognitionResultEvent) => void)
      | (() => void),
  ): void {
    switch (type) {
      case "result":
        this.resultListeners.delete(listener as (event: FakeRecognitionResultEvent) => void);
        break;
      case "error":
        this.errorListeners.delete(listener as (event: FakeRecognitionErrorEvent) => void);
        break;
      case "start":
        this.startListeners.delete(listener as () => void);
        break;
      case "end":
        this.endListeners.delete(listener as () => void);
        break;
    }
  }

  emit(segments: Array<{ transcript: string; isFinal: boolean }>, resultIndex = 0): void {
    const results = segments.map(
      (s) => ({ 0: { transcript: s.transcript }, isFinal: s.isFinal, length: 1 }) as FakeResult,
    );
    (results as unknown as { length: number }).length = segments.length;
    const event = { resultIndex, results: results as unknown as ArrayLike<FakeResult> };
    for (const listener of this.resultListeners) {
      listener(event);
    }
  }

  emitError(error: string): void {
    const event = { error };
    for (const listener of this.errorListeners) {
      listener(event);
    }
  }

  emitEnd(): void {
    for (const listener of this.endListeners) {
      listener();
    }
  }

  private emitStart(): void {
    for (const listener of this.startListeners) {
      listener();
    }
  }

  static last(): FakeRecognition {
    const inst = FakeRecognition.instances.at(-1);
    if (!inst) {
      throw new Error("no FakeRecognition instance created");
    }
    return inst;
  }
}

function installFake(): void {
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition = FakeRecognition;
}

function uninstallFake(): void {
  delete (window as unknown as Record<string, unknown>).webkitSpeechRecognition;
  delete (window as unknown as Record<string, unknown>).SpeechRecognition;
}

beforeEach(() => {
  FakeRecognition.instances = [];
  installFake();
});

afterEach(() => {
  uninstallFake();
});

describe("isDictationSupported", () => {
  it("is true when a recognition constructor exists", () => {
    expect(isDictationSupported()).toBe(true);
  });

  it("is false when no recognition constructor exists", () => {
    uninstallFake();
    expect(isDictationSupported()).toBe(false);
  });
});

describe("DictationController", () => {
  it("streams interim text and accumulates finalized segments", () => {
    const onText = vi.fn();
    const controller = new DictationController({ onText });
    controller.start();

    FakeRecognition.last().emit([{ transcript: "hello", isFinal: false }]);
    expect(onText).toHaveBeenLastCalledWith("hello");

    FakeRecognition.last().emit([{ transcript: "hello world", isFinal: true }]);
    expect(onText).toHaveBeenLastCalledWith("hello world");

    // A later interim builds on the already-finalized text.
    FakeRecognition.last().emit([{ transcript: " and more", isFinal: false }]);
    expect(onText).toHaveBeenLastCalledWith("hello world and more");
  });

  it("fires onStart when recognition begins", () => {
    const onStart = vi.fn();
    new DictationController({ onText: vi.fn(), onStart }).start();
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("auto-restarts when recognition ends while still active", () => {
    const controller = new DictationController({ onText: vi.fn() });
    controller.start();
    const recognition = FakeRecognition.last();
    expect(recognition.startCount).toBe(1);

    // Browsers end recognition after silence; controller should restart it.
    recognition.emitEnd();
    expect(recognition.startCount).toBe(2);
    // No new instance — the same recognition is reused.
    expect(FakeRecognition.instances).toHaveLength(1);
  });

  it("stops gracefully without restarting and reports onEnd", () => {
    const onEnd = vi.fn();
    const controller = new DictationController({ onText: vi.fn(), onEnd });
    controller.start();
    const recognition = FakeRecognition.last();

    controller.stop();
    expect(recognition.stopCount).toBe(1);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(controller.isActive).toBe(false);
    // Did not restart after the user-initiated stop.
    expect(recognition.startCount).toBe(1);
  });

  it("surfaces a friendly message and stops on a permission error", () => {
    const onError = vi.fn();
    const controller = new DictationController({ onText: vi.fn(), onError });
    controller.start();

    FakeRecognition.last().emitError("not-allowed");
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/denied/i);
    expect(controller.isActive).toBe(false);
  });

  it("ignores benign no-speech/aborted errors", () => {
    const onError = vi.fn();
    const controller = new DictationController({ onText: vi.fn(), onError });
    controller.start();

    FakeRecognition.last().emitError("no-speech");
    FakeRecognition.last().emitError("aborted");
    expect(onError).not.toHaveBeenCalled();
    expect(controller.isActive).toBe(true);
  });

  it("reports an error instead of throwing when unsupported", () => {
    uninstallFake();
    const onError = vi.fn();
    new DictationController({ onText: vi.fn(), onError }).start();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/support/i);
  });
});
