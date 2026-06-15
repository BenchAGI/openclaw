import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GatewayDictationController,
  isMediaCaptureSupported,
  type TranscribeClient,
} from "./gateway-dictation.ts";

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }
  state: "inactive" | "recording" | "paused" = "inactive";
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_stream: unknown, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["clip"], { type: this.mimeType }) });
    this.onstop?.();
  }

  static last(): FakeMediaRecorder {
    const inst = FakeMediaRecorder.instances.at(-1);
    if (!inst) throw new Error("no FakeMediaRecorder created");
    return inst;
  }
}

class FakeFileReader {
  result: string | null = null;
  error: unknown = null;
  onloadend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(_blob: Blob): void {
    this.result = "data:audio/webm;base64,QUJD"; // base64 for "ABC"
    queueMicrotask(() => this.onloadend?.());
  }
}

const trackStop = vi.fn();

function installCaptureStubs(getUserMedia?: () => Promise<MediaStream>): void {
  const stream = { getTracks: () => [{ stop: trackStop }] } as unknown as MediaStream;
  (navigator as unknown as { mediaDevices: unknown }).mediaDevices = {
    getUserMedia: getUserMedia ?? vi.fn().mockResolvedValue(stream),
  };
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeMediaRecorder;
  (globalThis as unknown as { FileReader: unknown }).FileReader = FakeFileReader;
}

function uninstallCaptureStubs(): void {
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
  delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
}

function fakeClient(transcript: string | Error): TranscribeClient {
  return {
    request: vi.fn(() =>
      transcript instanceof Error
        ? Promise.reject(transcript)
        : Promise.resolve({ transcript } as unknown),
    ) as TranscribeClient["request"],
  };
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  trackStop.mockReset();
  installCaptureStubs();
  let now = 1000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  (globalThis as unknown as { __advance: (ms: number) => void }).__advance = (ms: number) => {
    now += ms;
  };
});

afterEach(() => {
  uninstallCaptureStubs();
  vi.restoreAllMocks();
});

function advance(ms: number): void {
  (globalThis as unknown as { __advance: (ms: number) => void }).__advance(ms);
}

describe("isMediaCaptureSupported", () => {
  it("is true with mediaDevices + MediaRecorder present", () => {
    expect(isMediaCaptureSupported()).toBe(true);
  });

  it("is false without MediaRecorder", () => {
    delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    expect(isMediaCaptureSupported()).toBe(false);
  });
});

describe("GatewayDictationController", () => {
  it("records, transcribes via the gateway, and emits the transcript", async () => {
    const client = fakeClient("hello world");
    const onText = vi.fn();
    const onStart = vi.fn();
    const onStatus = vi.fn();
    const onEnd = vi.fn();
    const controller = new GatewayDictationController(client, {
      onText,
      onStart,
      onStatus,
      onEnd,
    });

    controller.start();
    await vi.waitFor(() => expect(onStart).toHaveBeenCalledTimes(1));
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(controller.isActive).toBe(true);

    advance(1000); // exceed the 250ms minimum
    controller.stop();

    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith("hello world"));
    expect(onStatus).toHaveBeenCalledWith("transcribing");
    const requestMock = client.request as ReturnType<typeof vi.fn>;
    expect(requestMock).toHaveBeenCalledTimes(1);
    const [method, params] = requestMock.mock.calls[0];
    expect(method).toBe("audio.transcribe");
    expect(params).toMatchObject({ audioBase64: "QUJD" });
    expect((params as { mimeType: string }).mimeType).toMatch(/^audio\/webm/);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(controller.isActive).toBe(false);
    expect(trackStop).toHaveBeenCalled(); // mic released
  });

  it("discards clips below the minimum duration without transcribing", async () => {
    const client = fakeClient("ignored");
    const onText = vi.fn();
    const onEnd = vi.fn();
    const controller = new GatewayDictationController(client, { onText, onEnd });

    controller.start();
    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    controller.stop(); // no time advance → elapsed ~0ms

    await vi.waitFor(() => expect(onEnd).toHaveBeenCalledTimes(1));
    expect(client.request).not.toHaveBeenCalled();
    expect(onText).not.toHaveBeenCalled();
  });

  it("surfaces a friendly error when mic permission is denied", async () => {
    const denied = () => Promise.reject(new DOMException("denied", "NotAllowedError"));
    installCaptureStubs(denied);
    const onError = vi.fn();
    const controller = new GatewayDictationController(fakeClient("x"), {
      onText: vi.fn(),
      onError,
    });

    controller.start();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatch(/denied/i);
    expect(controller.isActive).toBe(false);
  });

  it("reports a transcription failure but still ends cleanly", async () => {
    const client = fakeClient(new Error("503 unavailable"));
    const onError = vi.fn();
    const onEnd = vi.fn();
    const controller = new GatewayDictationController(client, {
      onText: vi.fn(),
      onError,
      onEnd,
    });

    controller.start();
    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    advance(1000);
    controller.stop();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toMatch(/transcription failed/i);
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it("does not write to the composer if disposed mid-transcription", async () => {
    let resolveReq: ((value: { transcript: string }) => void) | null = null;
    const client: TranscribeClient = {
      request: vi.fn(
        () =>
          new Promise<{ transcript: string }>((res) => {
            resolveReq = res;
          }),
      ) as TranscribeClient["request"],
    };
    const onText = vi.fn();
    const onEnd = vi.fn();
    const controller = new GatewayDictationController(client, { onText, onEnd });

    controller.start();
    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(1));
    advance(1000);
    controller.stop();

    // Transcription request is in flight; disconnect before it resolves.
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    controller.dispose();
    resolveReq?.({ transcript: "too late" });
    await Promise.resolve();
    await Promise.resolve();

    expect(onText).not.toHaveBeenCalled();
    expect(controller.isActive).toBe(false);
  });
});
