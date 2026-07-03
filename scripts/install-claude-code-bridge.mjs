#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
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
const openclawHome = values.get("--openclaw-home") ?? process.env.OPENCLAW_HOME ?? path.join(home, ".openclaw");
const sourceDir = path.join(packageRoot, "extensions", "claude-code-bridge");
const targetDir = path.join(openclawHome, "claude-code-bridge");
const claudeSettingsPath = path.join(home, ".claude", "settings.json");
const launchAgentsDir = path.join(home, "Library", "LaunchAgents");
const mirrorPlistPath = path.join(launchAgentsDir, "ai.openclaw.claude-code-mirror.plist");

function detectNodeBin() {
  const found = spawnSync("/bin/bash", ["-lc", "command -v node"], { encoding: "utf8" });
  const candidate = found.status === 0 ? found.stdout.trim() : "";
  return candidate || process.execPath;
}

const nodeBin = values.get("--node") ?? detectNodeBin();

if (!existsSync(sourceDir)) {
  throw new Error(`bridge source directory not found: ${sourceDir}`);
}

function log(message) {
  process.stdout.write(`[openclaw-bridge] ${message}\n`);
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
      return !/claude-code-bridge\/session-bootstrap\.mjs/.test(command);
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
  const logDir = path.join(openclawHome, "logs");
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
    <key>BENCH_WIKI_MIRROR_FOLDERS</key>
    <string>canon,dreams,synthesis,protocols,consolidations,consolidation,sops,sop,diary</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>900</integer>

  <key>StandardOutPath</key>
  <string>${xmlEscape(path.join(logDir, "claude-code-mirror.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(path.join(logDir, "claude-code-mirror.err.log"))}</string>
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

await copyBridgeFiles();
await updateClaudeSettings();
await installLaunchAgent();

log(`bridge staged at ${targetDir}`);
