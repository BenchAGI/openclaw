import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Pack the openclaw package the same way `npm publish` would (honoring the
// package.json `files` allowlist) and install it into an isolated prefix, so
// callers can smoke the EXACT layout a consumer gets from `npm i openclaw`.
//
// `--ignore-scripts` is mandatory: the package defines a `prepack` lifecycle
// script (scripts/openclaw-prepack.ts) which itself runs pack smokes, so a
// plain `npm pack` here would recurse forever.

export function runPack(packDestination, cwd = process.cwd()) {
  const raw = execFileSync(
    "npm",
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDestination],
    {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024 * 100,
    },
  );
  return JSON.parse(raw);
}

export function resolvePackedTarballPath(packDestination, results) {
  const filenames = results
    .map((entry) => entry.filename)
    .filter((filename) => typeof filename === "string" && filename.length > 0);
  if (filenames.length !== 1) {
    throw new Error(`npm pack produced ${filenames.length} tarballs; expected exactly one.`);
  }
  return resolve(packDestination, filenames[0]);
}

export function installPackedTarball(prefixDir, tarballPath, cwd) {
  execFileSync(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      prefixDir,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      tarballPath,
    ],
    {
      cwd,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
}

export function resolveGlobalRoot(prefixDir, cwd) {
  return execFileSync("npm", ["root", "-g", "--prefix", prefixDir], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

// Pack + install the package rooted at `packageCwd` into `tmpRoot`, returning
// the installed package root (`<globalRoot>/openclaw`). The returned root is a
// real, dependency-resolved install — it does NOT contain build-time-only
// artifacts such as the dist/extensions/node_modules/openclaw shim, so it
// faithfully mirrors the published tarball.
export function packAndInstallOpenclaw(tmpRoot, { packageCwd = process.cwd() } = {}) {
  const packDir = join(tmpRoot, "pack");
  mkdirSync(packDir, { recursive: true });
  const packResults = runPack(packDir, packageCwd);
  const tarballPath = resolvePackedTarballPath(packDir, packResults);
  const prefixDir = join(tmpRoot, "prefix");
  installPackedTarball(prefixDir, tarballPath, tmpRoot);
  const packageRoot = join(resolveGlobalRoot(prefixDir, tmpRoot), "openclaw");
  return { packageRoot, tarballPath };
}
