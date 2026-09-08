// Duplicate scanner integration tests use the real CLI and unchanged detection thresholds.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const tempDirs: string[] = [];
const checkScript = "scripts/check-duplicates.mts";
// The scanner's import closure: copied unchanged so the real CLI resolves its
// repository from its own location inside the fixture, not from this checkout.
const scannerModules = [
  checkScript,
  "scripts/lib/local-check-runtime.mts",
  "scripts/lib/managed-child-process.mts",
  "scripts/lib/repo-root.mjs",
  "scripts/lib/vitest-resource-ownership.mts",
  "scripts/lib/windows-taskkill.mjs",
  "scripts/windows-cmd-helpers.mjs",
];

afterEach(() => cleanupTempDirs(tempDirs));

function writeSource(root: string, file: string, source: string): void {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, source, "utf8");
}

function makeScannerRepo(files: Record<string, string>): string {
  const root = makeTempDir(tempDirs, "openclaw-duplicate-scan-");
  // Mirror the scanner's declared targets so coverage and scan planning run
  // together against the real CLI, not against mocks.
  for (const dir of [
    ".github/actions",
    ".github/codeql/openclaw-boundary/tests",
    "src",
    "extensions",
    "examples",
    "scripts",
    "packages",
    "ui",
    "apps",
    "docs",
    "qa",
    "security",
    "test",
    "skills",
    "config",
  ]) {
    mkdirSync(path.join(root, dir), { recursive: true });
  }
  for (const file of [
    "node-version.mjs",
    "openclaw.mjs",
    "tsdown.ai.config.ts",
    "tsdown.config.ts",
    "vitest.config.ts",
  ]) {
    writeSource(root, file, "export {};\n");
  }
  for (const file of scannerModules) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    copyFileSync(path.join(repoRoot, file), path.join(root, file));
  }
  for (const [file, source] of Object.entries(files)) {
    writeSource(root, file, source);
  }
  // tsx and jscpd resolve from the fixture's own node_modules.
  symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(root, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "--", ...scannerModules, ...Object.keys(files)], { cwd: root });
  return root;
}

function runScanner(root: string, flag: string) {
  return spawnSync(process.execPath, ["--import", "tsx", checkScript, flag], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

describe("duplicate scan coverage", () => {
  it("covers tracked GitHub policy modules and tests", () => {
    const root = makeScannerRepo({
      ".github/scripts/policy.mjs": "export {};\n",
      ".github/scripts/policy.test.mjs": "export {};\n",
      ".github/scripts/policy.fixture.mjs": "export {};\n",
    });
    const result = runScanner(root, "--coverage");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("target coverage ok");
  });

  it("still refuses tracked source outside real scan targets", () => {
    const root = makeScannerRepo({
      ".github/scripts/policy.mjs": "export {};\n",
      "uncovered/policy.mjs": "export {};\n",
    });
    const result = runScanner(root, "--coverage");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("uncovered/policy.mjs");
    expect(result.stderr).not.toContain(".github/scripts/policy.mjs");
  });

  it("actually detects long policy clones in production and test scans", () => {
    // Exceed the real 50-line/300-token minimum rather than reducing the gate.
    const source = [
      "export function policyScore(input) {",
      "  let score = 0;",
      ...Array.from({ length: 80 }, (_, index) => `  score += input[${index}] * ${index + 1};`),
      "  return score;",
      "}",
      "",
    ].join("\n");
    const root = makeScannerRepo({
      ".github/scripts/policy-a.mjs": source,
      ".github/scripts/policy-b.mjs": source,
      ".github/scripts/policy-a.test.mjs": source,
      ".github/scripts/policy-b.test.mjs": source,
    });
    const result = runScanner(root, "--json");
    const scans = [
      ["production", ".mjs"],
      ["tests", ".test.mjs"],
    ] as const;
    for (const [scan, suffix] of scans) {
      const report = JSON.parse(
        readFileSync(path.join(root, ".artifacts/jscpd", scan, "jscpd-report.json"), "utf8"),
      );
      type CloneReport = {
        lines: number;
        firstFile: { name: string; startLoc: { position: number }; endLoc: { position: number } };
        secondFile: { name: string };
      };
      const clones = (report.duplicates as CloneReport[]).filter((clone) => {
        const names = [clone.firstFile.name, clone.secondFile.name].map((name) =>
          name.replaceAll("\\", "/"),
        );
        // jscpd 5 reports file names relative to the scanned target, so the
        // `.github/scripts/` prefix is not part of the name; the fixture only
        // places policy files there, so the basename identifies them.
        return (
          names.some((name) => /(?:^|\/)policy-a\.[a-z.]+$/u.test(name) && name.endsWith(suffix)) &&
          names.some((name) => /(?:^|\/)policy-b\.[a-z.]+$/u.test(name) && name.endsWith(suffix))
        );
      });
      expect(clones, `${scan} must scan actual GitHub policy code`).not.toHaveLength(0);
      const clone = clones[0];
      if (!clone) {
        throw new Error(`${scan} clone list is empty`);
      }
      expect(clone.lines).toBeGreaterThanOrEqual(50);
      // jscpd's JSON reporter leaves `tokens` at zero; locations carry token positions.
      expect(
        clone.firstFile.endLoc.position - clone.firstFile.startLoc.position,
      ).toBeGreaterThanOrEqual(300);
    }
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0);
  });
});
