import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationController, isDictationSupported } from "./dictation.ts";

interface FakeResult {
  isFinal: boolean;
  length: number;
  0: { transcript: string };
}

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onresult: ((event: { resultIndex: number; results: ArrayLike<FakeResult> }) => void) | null =
    null;
  onerror: ((event: { error: string }) => void) | null = null;
  onend: (() => void) | null = null;
  onstart: (() => void) | null = null;
  startCount = 0;
  stopCount = 0;
  abortCount = 0;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start(): void {
    this.startCount++;
    this.onstart?.();
  }

  stop(): void {
    this.stopCount++;
    this.onend?.();
  }

  abort(): void {
    this.abortCount++;
  }

  emit(segments: Array<{ transcript: string; isFinal: boolean }>, resultIndex = 0): void {
    const results = segments.map(
      (s) => ({ 0: { transcript: s.transcript }, isFinal: s.isFinal, length: 1 }) as FakeResult,
    );
    (results as unknown as { length: number }).length = segments.length;
    this.onresult?.({ resultIndex, results: results as unknown as ArrayLike<FakeResult> });
  }

  static last(): FakeRecognition {
    const inst = FakeRecognition.instances.at(-1);
    if (!inst) throw new Error("no FakeRecognition instance created");
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
    recognition.onend?.();
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

    FakeRecognition.last().onerror?.({ error: "not-allowed" });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatch(/denied/i);
    expect(controller.isActive).toBe(false);
  });

  it("ignores benign no-speech/aborted errors", () => {
    const onError = vi.fn();
    const controller = new DictationController({ onText: vi.fn(), onError });
    controller.start();

    FakeRecognition.last().onerror?.({ error: "no-speech" });
    FakeRecognition.last().onerror?.({ error: "aborted" });
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
