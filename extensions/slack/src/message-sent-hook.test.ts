import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const { resetLogger, setLoggerOverride } = await import("openclaw/plugin-sdk/runtime-env");
const { emitSlackMessageSentHooks } = await import("./message-sent-hook.js");

let logCaptureCounter = 0;

function captureLogs(): string {
  logCaptureCounter += 1;
  const logFile = `/tmp/openclaw-slack-sent-log-${process.pid}-${logCaptureCounter}.jsonl`;
  fs.rmSync(logFile, { force: true });
  setLoggerOverride({ level: "info", consoleLevel: "silent", file: logFile });
  return logFile;
}

function readLogText(logFile: string): string {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
}

// The file transport flushes asynchronously; wait for the first line to land.
async function capturedLogText(logFile: string): Promise<string> {
  return await vi.waitFor(() => {
    const text = readLogText(logFile);
    expect(text.length).toBeGreaterThan(0);
    return text;
  });
}

afterEach(() => {
  setLoggerOverride(null);
  resetLogger();
});

describe("slack outbound delivery logging", () => {
  it("records a successful send with its routing envelope", async () => {
    const logFile = captureLogs();

    emitSlackMessageSentHooks({
      to: "C0AAA0RBEG1",
      accountId: "default",
      content: "here is your A/R summary",
      success: true,
      messageId: "1786500000.123456",
      isGroup: true,
      groupId: "C0AAA0RBEG1",
    });

    const logs = await capturedLogText(logFile);
    expect(logs).toContain("slack outbound send ok");
    expect(logs).toContain("to=C0AAA0RBEG1");
    expect(logs).toContain("messageId=1786500000.123456");
    expect(logs).toContain("accountId=default");
  });

  it("records a FAILED send with the Slack error", async () => {
    // `channel_not_found` and `not_in_channel` are the two that actually
    // happen in the field, and both are actionable by an operator.
    const logFile = captureLogs();

    emitSlackMessageSentHooks({
      to: "C06US0Z9U4R",
      content: "reply that never landed",
      success: false,
      error: "channel_not_found",
    });

    const logs = await capturedLogText(logFile);
    expect(logs).toContain("slack outbound send FAILED");
    expect(logs).toContain("error=channel_not_found");
  });

  it("never writes message content to the log", async () => {
    const logFile = captureLogs();
    const secret = "Allstate claim 0827139387 for Wahid Mirza";

    emitSlackMessageSentHooks({
      to: "D01234567",
      content: secret,
      success: true,
      messageId: "1786500000.222222",
    });

    const logs = await capturedLogText(logFile);
    expect(logs).not.toContain(secret);
    expect(logs).not.toContain("0827139387");
    // Length only — enough to tell an empty reply from a real one.
    expect(logs).toContain(`chars=${secret.length}`);
  });

  it("logs even when no plugin observes message_sent", async () => {
    // The hook path self-gates on registered listeners. Logging must NOT sit
    // behind that gate, or an operator with no plugins gets no outbound record
    // at all — which is the gap this fixes.
    const logFile = captureLogs();

    emitSlackMessageSentHooks({
      to: "C0BLDGPHBQD",
      content: "ok",
      success: true,
      messageId: "1786500000.333333",
    });

    expect(await capturedLogText(logFile)).toContain("slack outbound send ok");
  });

  it("reports chars=0 for an empty reply rather than omitting the field", async () => {
    // An empty outbound is a real failure mode and must be visible as one.
    const logFile = captureLogs();

    emitSlackMessageSentHooks({
      to: "C0BLDGPHBQD",
      content: "",
      success: true,
      messageId: "1786500000.444444",
    });

    expect(await capturedLogText(logFile)).toContain("chars=0");
  });
});
