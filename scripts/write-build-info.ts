// Write Build Info script supports OpenClaw repository automation.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(rootDir, "dist");
const pkgPath = path.join(rootDir, "package.json");

const readPackageVersion = () => {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? null;
  } catch {
    return null;
  }
};

const resolveCommit = () => {
  const envCommit = process.env.GIT_COMMIT?.trim() || process.env.GIT_SHA?.trim();
  if (envCommit) {
    return envCommit;
  }
  try {
    return execSync("git rev-parse HEAD", {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const resolveRelease = () => {
  const envRelease = process.env.GIT_RELEASE?.trim();
  if (envRelease) {
    return envRelease;
  }
  try {
    // The bench fork's release identity is the git TAG (e.g. 2026.6.8-bench.3), not
    // package.json (which deliberately tracks the upstream base). `describe` surfaces the
    // nearest tag + commits-ahead + short sha, so a running build self-reports its true
    // lineage even though `version` stays at the upstream base.
    return execSync("git describe --tags --always --dirty", {
      cwd: rootDir,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
};

const version = readPackageVersion();
const commit = resolveCommit();
const release = resolveRelease();

const buildInfo = {
  version,
  release,
  commit,
  builtAt: new Date().toISOString(),
};

fs.mkdirSync(distDir, { recursive: true });
fs.writeFileSync(path.join(distDir, "build-info.json"), `${JSON.stringify(buildInfo, null, 2)}\n`);
