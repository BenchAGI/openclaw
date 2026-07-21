#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(scriptDir, "..");

const flags = new Set();
const values = new Map();
const rawArgs = process.argv.slice(2);
for (let i = 0; i < rawArgs.length; i += 1) {
  const arg = rawArgs[i];
  if (arg === "--home" || arg === "--openclaw-home" || arg === "--node") {
    const value = rawArgs[i + 1];
    if (!value) {
      throw new Error(`${arg} requires a value`);
    }
    values.set(arg, value);
    i += 1;
  } else {
    flags.add(arg);
  }
}

if (flags.has("-h") || flags.has("--help")) {
  process.stdout.write(`Usage: node scripts/install-claude-code-bridge.mjs [options]

Stages the OpenClaw assistant bridge for Claude Code and local Codex-adjacent
workflows. It is idempotent and safe to rerun.

Options:
  --dry-run             Print planned work without writing files.
  --home <path>         Home directory to configure. Defaults to os.homedir().
  --openclaw-home <p>   OpenClaw home. Defaults to <home>/.openclaw.
  --node <path>         Node executable for generated settings/plists.
  --no-claude-settings  Do not update ~/.claude/settings.json.
  --no-launchd          Do not write the Claude memory mirror LaunchAgent.
  --no-load             Write LaunchAgent but do not load it.
`);
  process.exit(0);
}

const dryRun = flags.has("--dry-run");
const home = values.get("--home") ?? os.homedir();
const openclawHome =
  values.get("--openclaw-home") ?? process.env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
const sourceDir = path.join(packageRoot, "extensions", "claude-code-bridge");
const targetDir = path.join(openclawHome, "claude-code-bridge");
const claudeSettingsPath = path.join(home, ".claude", "settings.json");
const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
const mirrorPlistPath = path.join(launchAgentsDir, "ai.openclaw.claude-code-mirror.plist");
const launchAgentLogDir = path.join(openclawHome, "logs");

const requiredBridgeImports = ["@modelcontextprotocol/sdk/server/mcp.js", "zod"];

function resolveCommandPath(command) {
  if (!command) {
    return null;
  }
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
    return path.resolve(command);
  }
  const result =
    process.platform === "win32"
      ? spawnSync("where.exe", [command], { encoding: "utf8", windowsHide: true })
      : spawnSync("/bin/sh", ["-c", 'command -v "$1"', "sh", command], { encoding: "utf8" });
  const resolved = result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] : "";
  return resolved || null;
}

function detectNodeBin() {
  return resolveCommandPath("node") ?? process.execPath;
}

const nodeBin = values.get("--node") ?? detectNodeBin();

if (!existsSync(sourceDir)) {
  throw new Error(`bridge source directory not found: ${sourceDir}`);
}

function log(message) {
  process.stdout.write(`[openclaw-bridge] ${message}\n`);
}

function packageNameFromSpecifier(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

async function lstatOrNull(filePath) {
  try {
    return await fs.lstat(filePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function preferStablePnpmPackageRoot(packageRootPath) {
  const marker = `${path.sep}node_modules${path.sep}.pnpm${path.sep}`;
  const markerIndex = packageRootPath.lastIndexOf(marker);
  if (markerIndex < 0) {
    return packageRootPath;
  }
  const globalNodeModules = packageRootPath.slice(
    0,
    markerIndex + `${path.sep}node_modules`.length,
  );
  // Pnpm upgrades replace versioned store paths but retarget this package link.
  const stablePackageRoot = path.join(globalNodeModules, "openclaw");
  try {
    return (await fs.realpath(stablePackageRoot)) === (await fs.realpath(packageRootPath))
      ? stablePackageRoot
      : packageRootPath;
  } catch {
    return packageRootPath;
  }
}

async function findOpenClawRuntime(startPath) {
  let currentPath;
  try {
    const absoluteStartPath = path.resolve(startPath);
    const startStat = await fs.stat(absoluteStartPath);
    if (startStat.isDirectory()) {
      // Preserve package-manager-owned symlink paths so upgrades can retarget them.
      currentPath = absoluteStartPath;
    } else if ((await fs.lstat(absoluteStartPath)).isSymbolicLink()) {
      const linkTarget = await fs.readlink(absoluteStartPath);
      currentPath = path.dirname(path.resolve(path.dirname(absoluteStartPath), linkTarget));
    } else {
      currentPath = path.dirname(await fs.realpath(absoluteStartPath));
    }
  } catch {
    return null;
  }

  while (true) {
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(currentPath, "package.json"), "utf8"),
      );
      if (manifest?.name === "openclaw") {
        currentPath = await preferStablePnpmPackageRoot(currentPath);
        const nodeModulesPath = path.join(currentPath, "node_modules");
        const realNodeModulesPath = await fs.realpath(nodeModulesPath);
        const resolver = createRequire(path.join(currentPath, "package.json"));
        for (const specifier of requiredBridgeImports) {
          await fs.lstat(path.join(nodeModulesPath, packageNameFromSpecifier(specifier)));
          resolver.resolve(specifier);
        }
        return {
          packageRoot: currentPath,
          nodeModulesPath,
          realNodeModulesPath,
          version: typeof manifest.version === "string" ? manifest.version : "unknown",
        };
      }
    } catch {
      // Keep walking toward the filesystem root.
    }
    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

function resolveGlobalPackageRoot(manager) {
  const managerBin = resolveCommandPath(manager);
  if (!managerBin) {
    return null;
  }
  const result = spawnSync(managerBin, ["root", "-g"], {
    encoding: "utf8",
    timeout: 3_000,
    windowsHide: true,
    shell: process.platform === "win32",
  });
  const globalRoot = result.status === 0 ? result.stdout.trim().split(/\r?\n/u)[0] : "";
  return globalRoot ? path.join(globalRoot, "openclaw") : null;
}

async function resolveBridgeRuntimeDependencies() {
  const activeCandidates = [];
  const configuredBin = process.env.OPENCLAW_BIN?.trim();
  const openclawBin = resolveCommandPath(configuredBin || "openclaw");
  if (openclawBin) {
    activeCandidates.push(
      openclawBin,
      path.join(path.dirname(openclawBin), "node_modules", "openclaw"),
    );
  }
  for (const candidate of activeCandidates) {
    const runtime = await findOpenClawRuntime(candidate);
    if (runtime) {
      return runtime;
    }
  }

  const globalCandidates = ["npm", "pnpm"]
    .map(resolveGlobalPackageRoot)
    .filter((candidate) => candidate !== null);
  const bunInstall = process.env.BUN_INSTALL?.trim() || path.join(os.homedir(), ".bun");
  globalCandidates.push(path.join(bunInstall, "install", "global", "node_modules", "openclaw"));
  for (const candidate of globalCandidates) {
    const runtime = await findOpenClawRuntime(candidate);
    if (runtime) {
      return runtime;
    }
  }
  const packageRuntime = await findOpenClawRuntime(packageRoot);
  if (packageRuntime) {
    return packageRuntime;
  }
  throw new Error(
    `cannot locate OpenClaw-owned dependencies for ${requiredBridgeImports.join(
      " and ",
    )}; install this package's dependencies or set OPENCLAW_BIN to the active OpenClaw executable`,
  );
}

async function stageBridgeDependencies(runtime) {
  const dependencyPath = path.join(targetDir, "node_modules");
  const existing = await lstatOrNull(dependencyPath);
  if (existing?.isDirectory() && !existing.isSymbolicLink()) {
    log(`using existing bridge dependency directory ${dependencyPath}`);
    return { mode: "unchanged", dependencyPath };
  }
  if (existing?.isSymbolicLink()) {
    try {
      const currentTarget = await fs.realpath(dependencyPath);
      if (currentTarget === runtime.realNodeModulesPath) {
        log(`using existing bridge dependency link ${dependencyPath}`);
        return { mode: "unchanged", dependencyPath };
      }
    } catch {
      // A broken dependency link is safe to repair below.
    }
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new Error(`refusing to replace non-directory bridge dependency path: ${dependencyPath}`);
  }

  if (dryRun) {
    log(`link ${dependencyPath} -> ${runtime.nodeModulesPath}`);
    return { mode: "unchanged", dependencyPath };
  }

  await fs.mkdir(targetDir, { recursive: true });
  const backupPath = `${dependencyPath}.backup-${process.pid}-${Date.now()}`;
  let backedUpExistingLink = false;
  try {
    if (existing?.isSymbolicLink()) {
      await fs.rename(dependencyPath, backupPath);
      backedUpExistingLink = true;
    }
    await fs.symlink(
      runtime.nodeModulesPath,
      dependencyPath,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (err) {
    if (backedUpExistingLink) {
      try {
        await fs.rename(backupPath, dependencyPath);
      } catch (restoreError) {
        throw new Error(
          `failed to stage bridge dependencies (${err.message}) and restore ${backupPath}`,
          { cause: restoreError },
        );
      }
    }
    throw err;
  }
  log(
    `linked bridge dependencies to OpenClaw ${runtime.version} runtime at ${runtime.packageRoot}`,
  );
  return backedUpExistingLink
    ? { mode: "replaced", dependencyPath, backupPath }
    : { mode: "created", dependencyPath };
}

async function rollbackBridgeDependencies(stage) {
  if (stage.mode === "unchanged") {
    return;
  }
  const current = await lstatOrNull(stage.dependencyPath);
  if (current && !current.isSymbolicLink()) {
    throw new Error(`refusing to remove changed dependency path: ${stage.dependencyPath}`);
  }
  if (current) {
    await fs.rm(stage.dependencyPath);
  }
  if (stage.mode === "replaced") {
    await fs.rename(stage.backupPath, stage.dependencyPath);
  }
}

async function finalizeBridgeDependencies(stage) {
  if (stage.mode === "replaced") {
    await fs.rm(stage.backupPath);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function writeFileAtomic(filePath, content, mode) {
  if (dryRun) {
    log(`write ${filePath}`);
    return;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, content, "utf8");
  if (mode !== undefined) {
    await fs.chmod(tmp, mode);
  }
  await fs.rename(tmp, filePath);
}

async function copyBridgeFiles() {
  const files = [
    "README.md",
    "serve.mjs",
    "mirror.mjs",
    "cloud-mirror.mjs",
    "statusline.mjs",
    "session-bootstrap.mjs",
    "ai.openclaw.wiki-mirror.plist.template",
  ];

  if (!dryRun) {
    await fs.mkdir(targetDir, { recursive: true });
  }

  for (const fileName of files) {
    const src = path.join(sourceDir, fileName);
    const dst = path.join(targetDir, fileName);
    if (dryRun) {
      log(`copy ${src} -> ${dst}`);
      continue;
    }
    await fs.copyFile(src, dst);
    if (fileName.endsWith(".mjs")) {
      await fs.chmod(dst, 0o755);
    }
  }

  const mirrorAlias = path.join(targetDir, "claude-code-mirror.mjs");
  if (dryRun) {
    log(`copy ${path.join(sourceDir, "mirror.mjs")} -> ${mirrorAlias}`);
  } else {
    await fs.copyFile(path.join(sourceDir, "mirror.mjs"), mirrorAlias);
    await fs.chmod(mirrorAlias, 0o755);
  }
}

function verifyBridgeRuntime() {
  const serverPath = path.join(targetDir, "serve.mjs");
  if (dryRun) {
    log(`verify ${serverPath} --once-list-tools`);
    return;
  }

  const result = spawnSync(nodeBin, [serverPath, "--once-list-tools"], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      OPENCLAW_HOME: openclawHome,
      OPENCLAW_BRIDGE_AUTOSTART: "false",
      BENCH_HARNESS_MANIFEST_ENFORCE: "false",
    },
  });
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.error?.message || "unknown runtime error";
    throw new Error(`staged bridge runtime verification failed: ${detail}`);
  }
  try {
    const descriptors = JSON.parse(result.stdout);
    if (!Array.isArray(descriptors) || descriptors.length === 0) {
      throw new Error("tool descriptor list is empty");
    }
  } catch (err) {
    throw new Error(`staged bridge runtime verification returned invalid output: ${err.message}`, {
      cause: err,
    });
  }
  log("verified staged bridge runtime imports");
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") {
      return {};
    }
    throw err;
  }
}

function withoutBridgeSessionHooks(sessionStart) {
  const groups = Array.isArray(sessionStart) ? sessionStart : [];
  const cleaned = [];
  for (const group of groups) {
    if (!group || typeof group !== "object") {
      cleaned.push(group);
      continue;
    }
    const hooks = Array.isArray(group.hooks) ? group.hooks : [];
    const nextHooks = hooks.filter((hook) => {
      const command = typeof hook?.command === "string" ? hook.command : "";
      return !/claude-code-bridge[\\/]+session-bootstrap\.mjs/.test(command);
    });
    if (nextHooks.length > 0) {
      cleaned.push({ ...group, hooks: nextHooks });
    }
  }
  return cleaned;
}

async function updateClaudeSettings() {
  if (flags.has("--no-claude-settings")) {
    log("skip Claude settings");
    return;
  }

  const settings = await readJsonFile(claudeSettingsPath);
  if (!settings.hooks || typeof settings.hooks !== "object") {
    settings.hooks = {};
  }
  settings.hooks.SessionStart = withoutBridgeSessionHooks(settings.hooks.SessionStart);
  settings.hooks.SessionStart.push({
    hooks: [
      {
        type: "command",
        command: `${shellQuote(nodeBin)} ${shellQuote(path.join(targetDir, "session-bootstrap.mjs"))}`,
      },
    ],
  });
  settings.statusLine = {
    type: "command",
    command: `${shellQuote(nodeBin)} ${shellQuote(path.join(targetDir, "statusline.mjs"))}`,
    refreshInterval: 30,
  };

  await writeFileAtomic(claudeSettingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

function renderMirrorPlist() {
  const mirrorPath = path.join(targetDir, "claude-code-mirror.mjs");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.openclaw.claude-code-mirror</string>

  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(nodeBin)}</string>
    <string>${xmlEscape(mirrorPath)}</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${xmlEscape(home)}</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>OPENCLAW_HOME</key>
    <string>${xmlEscape(openclawHome)}</string>
    <key>BENCH_WIKI_MIRROR_FOLDERS</key>
    <string>canon,dreams,synthesis,protocols,consolidations,consolidation,sops,sop,diary</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>900</integer>

  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(launchAgentLogDir, "claude-code-mirror.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(launchAgentLogDir, "claude-code-mirror.err.log"))}</string>
</dict>
</plist>
`;
}

function runLaunchctl(args, options = {}) {
  return spawnSync("launchctl", args, {
    stdio: options.stdio ?? "pipe",
    encoding: "utf8",
  });
}

async function installLaunchAgent() {
  if (flags.has("--no-launchd")) {
    log("skip launchd");
    return;
  }

  if (!dryRun) {
    await fs.mkdir(launchAgentLogDir, { recursive: true });
  }
  await writeFileAtomic(mirrorPlistPath, renderMirrorPlist());
  if (process.platform !== "darwin" || flags.has("--no-load")) {
    log(`wrote ${mirrorPlistPath}`);
    return;
  }
  if (dryRun) {
    log(`launchctl bootstrap gui/${process.getuid()} ${mirrorPlistPath}`);
    return;
  }

  const domain = `gui/${process.getuid()}`;
  runLaunchctl(["bootout", domain, mirrorPlistPath], { stdio: "ignore" });
  const boot = runLaunchctl(["bootstrap", domain, mirrorPlistPath]);
  if (boot.status === 0) {
    log("loaded ai.openclaw.claude-code-mirror");
    return;
  }
  const load = runLaunchctl(["load", mirrorPlistPath]);
  if (load.status === 0) {
    log("loaded ai.openclaw.claude-code-mirror via launchctl load");
    return;
  }
  process.stderr.write(
    `[openclaw-bridge] warning: launchctl load failed: ${load.stderr || boot.stderr || "unknown"}\n`,
  );
}

const bridgeRuntime = await resolveBridgeRuntimeDependencies();
const dependencyStage = await stageBridgeDependencies(bridgeRuntime);
try {
  await copyBridgeFiles();
  verifyBridgeRuntime();
} catch (err) {
  try {
    await rollbackBridgeDependencies(dependencyStage);
  } catch (rollbackError) {
    throw new Error(`bridge staging failed (${err.message}) and dependency rollback failed`, {
      cause: rollbackError,
    });
  }
  throw err;
}
await finalizeBridgeDependencies(dependencyStage);
await updateClaudeSettings();
await installLaunchAgent();

log(`bridge staged at ${targetDir}`);
