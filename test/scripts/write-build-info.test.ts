// Build info tests cover canonical package provenance generation.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  normalizeBuildCommit,
  normalizeBuildTimestamp,
  resolveBuildInfo,
  writeBuildInfo,
} from "../../scripts/write-build-info.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

describe("write-build-info", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function createPackage(version = "2026.7.10"): string {
    const rootDir = tempDirs.make("openclaw-build-info-");
    fs.writeFileSync(path.join(rootDir, "package.json"), `${JSON.stringify({ version })}\n`);
    return rootDir;
  }

  it("normalizes explicit release provenance and writes the shared manifest", () => {
    const rootDir = createPackage();
    const execFileSync = vi.fn(() => {
      throw new Error("Git fallback should not run");
    });

    const outputPath = writeBuildInfo({
      rootDir,
      env: {
        GIT_COMMIT: "ABCDEF0123456789ABCDEF0123456789ABCDEF01",
        GIT_RELEASE: "2026.7.10-bench.1",
        OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56Z",
      },
      execFileSync,
    });

    expect(execFileSync).not.toHaveBeenCalled();
    expect(path.relative(rootDir, outputPath)).toBe("dist/build-info.json");
    expect(JSON.parse(fs.readFileSync(outputPath, "utf8"))).toEqual({
      version: "2026.7.10",
      release: "2026.7.10-bench.1",
      commit: "abcdef0123456789abcdef0123456789abcdef01",
      builtAt: "2026-07-10T12:34:56.000Z",
      buildId: "2026.7.10-abcdef012345-2026-07-10T12-34-56.000Z",
    });
  });

  it("falls back to build-time Git and one current UTC timestamp for local builds", () => {
    const rootDir = createPackage("2026.7.10-beta.1");
    const execFileSync = vi.fn(() => "1234567890ABCDEF1234567890ABCDEF12345678\n");

    expect(
      resolveBuildInfo({
        rootDir,
        env: { GIT_RELEASE: "2026.7.10-beta.1-bench.1" },
        execFileSync,
        now: () => new Date("2026-07-10T01:02:03.456Z"),
      }),
    ).toEqual({
      version: "2026.7.10-beta.1",
      release: "2026.7.10-beta.1-bench.1",
      commit: "1234567890abcdef1234567890abcdef12345678",
      builtAt: "2026-07-10T01:02:03.456Z",
      buildId: "2026.7.10-beta.1-1234567890ab-2026-07-10T01-02-03.456Z",
    });
    expect(execFileSync).toHaveBeenCalledWith("git", ["rev-parse", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  });

  it("uses null when Git metadata is unavailable", () => {
    const rootDir = createPackage();

    expect(
      resolveBuildInfo({
        rootDir,
        env: {},
        execFileSync: () => {
          throw new Error("git unavailable");
        },
        now: () => new Date("2026-07-10T01:02:03.000Z"),
      }).commit,
    ).toBeNull();
  });

  it("shares explicit release artifact identity with the Control UI", () => {
    const rootDir = createPackage();
    expect(
      resolveBuildInfo({
        rootDir,
        env: {
          GIT_COMMIT: "a".repeat(40),
          OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T01:02:03.000Z",
          OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1",
        },
      }).buildId,
    ).toBe("2026.7.10-release-aaaaaaaaaaaa-2026-07-10T01-02-03.000Z");
  });

  it("preserves GIT_COMMIT then GIT_SHA explicit input precedence", () => {
    const rootDir = createPackage();
    const fallbackSha = "1234567890abcdef1234567890abcdef12345678";

    expect(
      resolveBuildInfo({
        rootDir,
        env: { GIT_SHA: fallbackSha },
        now: () => new Date("2026-07-10T01:02:03.000Z"),
      }).commit,
    ).toBe(fallbackSha);
    expect(() =>
      resolveBuildInfo({
        rootDir,
        env: { GIT_COMMIT: "bad", GIT_SHA: fallbackSha },
      }),
    ).toThrow("GIT_COMMIT must be a full 40-character Git commit SHA.");
  });

  it("uses checked-out Git instead of unverified GitHub workflow context", () => {
    const rootDir = createPackage();
    const checkedOutCommit = "b".repeat(40);
    const execFileSync = vi.fn(() => checkedOutCommit);

    expect(
      resolveBuildInfo({
        rootDir,
        env: { GITHUB_SHA: "a".repeat(40), GIT_RELEASE: "2026.7.10-bench.1" },
        execFileSync,
        now: () => new Date("2026-07-10T01:02:03.000Z"),
      }).commit,
    ).toBe(checkedOutCommit);
    expect(execFileSync).toHaveBeenCalledOnce();
    expect(
      resolveBuildInfo({
        rootDir,
        env: { GITHUB_SHA: "a".repeat(40) },
        execFileSync: () => {
          throw new Error("git unavailable");
        },
        now: () => new Date("2026-07-10T01:02:03.000Z"),
      }).commit,
    ).toBe("a".repeat(40));
    expect(() =>
      resolveBuildInfo({
        rootDir,
        env: { GITHUB_SHA: "bad" },
        execFileSync: () => {
          throw new Error("git unavailable");
        },
      }),
    ).toThrow("GITHUB_SHA must be a full 40-character Git commit SHA.");
  });

  it("rejects abbreviated or malformed explicit commits", () => {
    expect(() => normalizeBuildCommit("abc1234")).toThrow(
      "GIT_COMMIT must be a full 40-character Git commit SHA.",
    );
    expect(() => normalizeBuildCommit("g".repeat(40))).toThrow(
      "GIT_COMMIT must be a full 40-character Git commit SHA.",
    );
  });

  it("normalizes valid UTC timestamps and rejects offsets or impossible dates", () => {
    expect(normalizeBuildTimestamp("2026-07-10T12:34:56.7Z")).toBe("2026-07-10T12:34:56.700Z");
    expect(() => normalizeBuildTimestamp("2026-07-10T12:34:56+00:00")).toThrow(
      "OPENCLAW_BUILD_TIMESTAMP must be an ISO-8601 UTC timestamp ending in Z.",
    );
    expect(() => normalizeBuildTimestamp("2026-02-30T12:34:56Z")).toThrow(
      "OPENCLAW_BUILD_TIMESTAMP must be a valid ISO-8601 UTC timestamp.",
    );
  });
});

describe("write-build-info release lineage (Bench fork #85)", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  function createPackage(version = "2026.6.2"): string {
    const rootDir = tempDirs.make("openclaw-build-info-release-");
    fs.writeFileSync(path.join(rootDir, "package.json"), `${JSON.stringify({ version })}\n`);
    return rootDir;
  }

  it("writes the GIT_RELEASE override for hermetic package builds", () => {
    const rootDir = createPackage();
    const execFileSync = vi.fn(() => {
      throw new Error("Git fallback should not run");
    });
    const buildInfo = resolveBuildInfo({
      rootDir,
      env: {
        GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
        GIT_RELEASE: "  v2026.6.8-bench.3  ",
        OPENCLAW_BUILD_TIMESTAMP: "2026-07-10T12:34:56Z",
      },
      execFileSync,
    });
    expect(execFileSync).not.toHaveBeenCalled();
    expect(buildInfo.version).toBe("2026.6.2");
    expect(buildInfo.release).toBe("v2026.6.8-bench.3");
  });

  it("describes the nearest git tag and preserves the dirty marker", () => {
    const rootDir = createPackage();
    const execFileSync = vi.fn((_command: string, args: string[]) =>
      args[0] === "describe"
        ? "v2026.6.8-bench.3-1-gabc1234-dirty\n"
        : "1234567890abcdef1234567890abcdef12345678\n",
    );
    const buildInfo = resolveBuildInfo({
      rootDir,
      env: {},
      execFileSync: execFileSync as never,
      now: () => new Date("2026-07-10T01:02:03.456Z"),
    });
    expect(buildInfo.commit).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(buildInfo.release).toBe("v2026.6.8-bench.3-1-gabc1234-dirty");
  });
});
