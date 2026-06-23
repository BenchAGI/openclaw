// Write Build Info tests cover build metadata stamping behavior.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "openclaw-build-info-"));
  tempDirs.push(root);
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    `${JSON.stringify({ type: "module", version: "2026.6.2" })}\n`,
  );
  writeFileSync(
    path.join(root, "scripts", "write-build-info.ts"),
    readFileSync(path.join(process.cwd(), "scripts", "write-build-info.ts"), "utf8"),
  );
  return root;
}

function git(root: string, args: string[]) {
  execFileSync("git", args, {
    cwd: root,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    stdio: "ignore",
  });
}

function runWriteBuildInfo(root: string, env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/write-build-info.ts"],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `write-build-info failed with status ${result.status}: ${result.stderr || result.stdout}`,
    );
  }
  return JSON.parse(readFileSync(path.join(root, "dist", "build-info.json"), "utf8")) as {
    builtAt?: string;
    commit?: string | null;
    release?: string | null;
    version?: string | null;
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("write-build-info", () => {
  it("writes the release override for hermetic package builds", () => {
    const root = makeFixture();

    const buildInfo = runWriteBuildInfo(root, {
      GIT_COMMIT: "0123456789abcdef0123456789abcdef01234567",
      GIT_RELEASE: "  v2026.6.8-bench.3  ",
    });

    expect(buildInfo.version).toBe("2026.6.2");
    expect(buildInfo.commit).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(buildInfo.release).toBe("v2026.6.8-bench.3");
    expect(buildInfo.builtAt).toEqual(expect.any(String));
  });

  it("describes the nearest git tag and preserves the dirty marker", () => {
    const root = makeFixture();
    writeFileSync(path.join(root, "marker.txt"), "one\n");
    git(root, ["init"]);
    git(root, ["config", "user.email", "test@example.com"]);
    git(root, ["config", "user.name", "OpenClaw Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "initial"]);
    git(root, ["tag", "v2026.6.8-bench.3"]);
    writeFileSync(path.join(root, "marker.txt"), "two\n");
    git(root, ["add", "marker.txt"]);
    git(root, ["commit", "-m", "after tag"]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    writeFileSync(path.join(root, "marker.txt"), "dirty\n");

    const buildInfo = runWriteBuildInfo(root);

    expect(buildInfo.commit).toBe(head);
    expect(buildInfo.release).toMatch(/^v2026\.6\.8-bench\.3-1-g[0-9a-f]+-dirty$/u);
  });
});
