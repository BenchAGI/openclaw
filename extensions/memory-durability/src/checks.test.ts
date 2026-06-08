import { describe, expect, it } from "vitest";
import {
  coreFreshnessCheck,
  busLivenessCheck,
  plateDuplicationCheck,
  summarize,
} from "./checks.js";

const NOW = Date.parse("2026-06-08T04:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("coreFreshnessCheck", () => {
  it("fresh CORE.md => ok", () => {
    const c = coreFreshnessCheck({
      coreText: `Generated at: ${iso(NOW - 2 * 3600e3)}`,
      memoryMtimeMs: NOW - 5 * 3600e3,
      nowMs: NOW,
      maxAgeHours: 26,
    });
    expect(c.status).toBe("ok");
  });
  it("CORE older than cap => fail", () => {
    const c = coreFreshnessCheck({
      coreText: `Generated at: ${iso(NOW - 40 * 3600e3)}`,
      memoryMtimeMs: NOW - 50 * 3600e3,
      nowMs: NOW,
      maxAgeHours: 26,
    });
    expect(c.status).toBe("fail");
  });
  it("CORE far behind MEMORY => fail", () => {
    const c = coreFreshnessCheck({
      coreText: `Generated at: ${iso(NOW - 30 * 3600e3)}`,
      memoryMtimeMs: NOW - 1 * 3600e3,
      nowMs: NOW,
      maxAgeHours: 26,
    });
    expect(c.status).toBe("fail");
  });
  it("unparseable Generated-at => error (not silently ok)", () => {
    expect(
      coreFreshnessCheck({
        coreText: "no timestamp",
        memoryMtimeMs: null,
        nowMs: NOW,
        maxAgeHours: 26,
      }).status,
    ).toBe("error");
  });
});

describe("busLivenessCheck", () => {
  it("recent converged + HEAD==origin => ok", () => {
    const c = busLivenessCheck({
      logTail: `${iso(NOW - 30e3)} ok: converged at abc1234`,
      head: "deadbeef",
      origin: "deadbeef",
      nowMs: NOW,
      maxAgeSec: 600,
    });
    expect(c.status).toBe("ok");
  });
  it("CONFLICT => fail", () => {
    const c = busLivenessCheck({
      logTail: `${iso(NOW - 10e3)} CONFLICT: rebase aborted`,
      head: null,
      origin: null,
      nowMs: NOW,
      maxAgeSec: 600,
    });
    expect(c.status).toBe("fail");
  });
  it("stale log => fail (syncer dead)", () => {
    const c = busLivenessCheck({
      logTail: `${iso(NOW - 3600e3)} ok: converged at abc1234`,
      head: "a",
      origin: "a",
      nowMs: NOW,
      maxAgeSec: 600,
    });
    expect(c.status).toBe("fail");
  });
  it("HEAD != origin => fail", () => {
    const c = busLivenessCheck({
      logTail: `${iso(NOW - 30e3)} ok: converged at abc1234`,
      head: "aaaaaaa",
      origin: "bbbbbbb",
      nowMs: NOW,
      maxAgeSec: 600,
    });
    expect(c.status).toBe("fail");
  });
  it("WARN offline => skipped (transient)", () => {
    const c = busLivenessCheck({
      logTail: `${iso(NOW - 30e3)} WARN: bus unreachable`,
      head: null,
      origin: null,
      nowMs: NOW,
      maxAgeSec: 600,
    });
    expect(c.status).toBe("skipped");
  });
});

describe("plateDuplicationCheck", () => {
  it("one block, unique headings => ok", () => {
    const md =
      "# MEMORY\n<!-- aurelius-live-plate:start -->\nx\n<!-- aurelius-live-plate:end -->\n## A\n## B\n";
    expect(plateDuplicationCheck({ memoryText: md }).status).toBe("ok");
  });
  it("duplicated plate markers => fail", () => {
    const md =
      "<!-- aurelius-live-plate:start -->\n<!-- aurelius-live-plate:start -->\n<!-- aurelius-live-plate:end -->\n<!-- aurelius-live-plate:end -->\n";
    expect(plateDuplicationCheck({ memoryText: md }).status).toBe("fail");
  });
  it("duplicated heading => fail, wording-independent", () => {
    const md =
      "<!-- aurelius-live-plate:start -->\nx\n<!-- aurelius-live-plate:end -->\n## Standing Rules\n## Standing Rules\n";
    expect(plateDuplicationCheck({ memoryText: md }).status).toBe("fail");
  });
});

describe("summarize", () => {
  it("any fail => not ok; any error => degraded", () => {
    const s = summarize([
      { name: "a", status: "ok", detail: "" },
      { name: "c", status: "error", detail: "" },
    ]);
    expect(s.ok).toBe(true);
    expect(s.degraded).toBe(true);
    const s2 = summarize([{ name: "a", status: "fail", detail: "" }]);
    expect(s2.ok).toBe(false);
    expect(s2.failed).toEqual(["a"]);
  });
});
