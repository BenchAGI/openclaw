#!/usr/bin/env node
// Periodic mirror: copies Claude Code's per-project auto-memory files into
// the OpenClaw wiki vault as bridge-style source pages, so OpenClaw agents can
// absorb them on the next dream cycle.
//
// Direction is one-way (Claude Code -> wiki). Reads still happen on demand
// via openclaw_wiki_search/_get from inside Claude Code.
//
// MEMORY FEDERATION: this mirror is host/user-namespaced so it can run on
// every machine and converge into one shared git-backed vault without
// collision. Each (user, machine) writes pages under a stable
// `originId = <user>.<machine>` prefix, and prune is scoped to that prefix so
// machines never delete each other's pages.
//
// IMPORTANT: this mirror always writes to wiki/main and intentionally ignores
// openclaw.json `instanceId`. cloud-mirror.mjs is the instanceId-aware lane
// (local vault -> benchagi.com); this lane is the device-convergence lane and
// must stay on the git-synced `main` vault, or memories get stranded in a
// per-instance vault.
//
// File naming: `claude-code-<originId>-<project-slug>-<file-slug>.md`
//   - Distinct prefix avoids collision with `bridge-<agent>-*.md`
//   - originId segment keeps each machine/user disjoint
//   - Deterministic (no random hash) so re-runs replace cleanly

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const HOME = os.homedir();
const OPENCLAW_HOME = process.env.OPENCLAW_HOME ?? path.join(HOME, ".openclaw");
const PROJECTS_DIR = path.join(HOME, ".claude", "projects");
const VAULT_DIR = path.join(OPENCLAW_HOME, "wiki", "main");
const SOURCES_DIR = path.join(VAULT_DIR, "sources");
const LOCK_PATH = path.join(VAULT_DIR, ".openclaw-wiki", "locks", "claude-code-mirror.lock");
const LOG_PATH = path.join(OPENCLAW_HOME, "logs", "claude-code-mirror.log");
const FILE_PREFIX = "claude-code-";

const MAX_FILE_BYTES = 256 * 1024; // skip giant memory files
const STALE_LOCK_MS = 5 * 60_000;

function slugify(value, max = 60) {
  const lower = String(value).toLowerCase();
  const cleaned = lower.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (cleaned.length <= max) {
    return cleaned || "x";
  }
  // truncate but keep an 8-char hash suffix for uniqueness
  const hash = createHash("sha256").update(String(value)).digest("hex").slice(0, 8);
  return `${cleaned.slice(0, max - 9)}-${hash}`;
}

function readMachineSlug() {
  if (process.env.BENCH_ORIGIN_MACHINE) {
    return slugify(process.env.BENCH_ORIGIN_MACHINE, 32);
  }
  try {
    const persisted = readFileSync(path.join(OPENCLAW_HOME, "machine-id"), "utf8").trim();
    if (persisted) {
      return slugify(persisted, 32);
    }
  } catch {
    // not persisted yet
  }
  try {
    const out = execSync("ioreg -rd1 -c IOPlatformExpertDevice", { encoding: "utf8" });
    const uuid = out.match(/IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1];
    if (uuid) {
      return slugify(uuid.slice(0, 8), 32);
    }
  } catch {
    // not a Mac / ioreg unavailable
  }
  return slugify(os.hostname().replace(/\.local$/, ""), 32);
}

const ORIGIN_USER = slugify(process.env.BENCH_ORIGIN_USER || os.userInfo().username, 24);
const ORIGIN_MACHINE = readMachineSlug();
const ORIGIN_ID = `${ORIGIN_USER}.${ORIGIN_MACHINE}`;
const ORIGIN_SLUG = slugify(ORIGIN_ID, 48);
const OUR_PAGE_PREFIX = `${FILE_PREFIX}${ORIGIN_SLUG}-`;

function decodeProjectName(rawDirName) {
  // Claude Code encodes the cwd as "-Users-name-project" (slashes -> dashes,
  // leading slash dropped). Reverse it for display, but keep the raw name as
  // the project key (it's stable and unambiguous).
  if (rawDirName.startsWith("-")) {
    return rawDirName.slice(1).replace(/-/g, "/");
  }
  return rawDirName;
}

async function listProjects() {
  const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

async function listProjectMemoryFiles(projectDirName) {
  const memoryDir = path.join(PROJECTS_DIR, projectDirName, "memory");
  const files = [];

  async function walk(dir, relativePrefix = "") {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const relativeName = relativePrefix ? path.join(relativePrefix, e.name) : e.name;
      const absolutePath = path.join(dir, e.name);
      if (e.isDirectory()) {
        await walk(absolutePath, relativeName);
        continue;
      }
      if (e.isFile() && e.name.endsWith(".md")) {
        files.push({
          absolutePath,
          relativeName: relativeName.split(path.sep).join("/"),
        });
      }
    }
  }

  await walk(memoryDir);
  return files;
}

function buildPagePath(projectDirName, fileName) {
  const projectSlug = slugify(projectDirName, 60);
  const fileSlug = slugify(fileName.replace(/\.md$/, ""), 40);
  return path.join("sources", `${OUR_PAGE_PREFIX}${projectSlug}-${fileSlug}.md`);
}

function buildPageId(projectDirName, fileName) {
  const projectHash = createHash("sha256").update(projectDirName).digest("hex").slice(0, 8);
  const fileHash = createHash("sha256").update(fileName).digest("hex").slice(0, 8);
  return `source.claude-code.${ORIGIN_ID}.${projectHash}.${fileName.replace(/\.md$/, "")}-${fileHash}`;
}

function yamlString(value) {
  return JSON.stringify(String(value));
}

function renderSourcePage({ projectDirName, fileName, absolutePath, content, sourceUpdatedAtMs }) {
  const projectDecoded = decodeProjectName(projectDirName);
  const id = buildPageId(projectDirName, fileName);
  const title = `Claude Code Memory (${path.basename(projectDecoded)}): ${fileName.replace(/\.md$/, "")}`;
  const updatedIso = new Date(sourceUpdatedAtMs).toISOString();

  const frontmatter = [
    "---",
    `pageType: ${yamlString("source")}`,
    `id: ${yamlString(id)}`,
    `title: ${yamlString(title)}`,
    `sourceType: ${yamlString("memory-bridge")}`,
    `originId: ${yamlString(ORIGIN_ID)}`,
    `originUser: ${yamlString(ORIGIN_USER)}`,
    `originMachine: ${yamlString(ORIGIN_MACHINE)}`,
    `sourcePath: ${yamlString(absolutePath)}`,
    `bridgeRelativePath: ${yamlString(fileName)}`,
    `bridgeWorkspaceDir: ${yamlString(path.dirname(absolutePath))}`,
    "bridgeAgentIds:",
    `  - ${yamlString("claude-code")}`,
    `status: ${yamlString("active")}`,
    `updatedAt: ${yamlString(updatedIso)}`,
    "---",
    "",
  ].join("\n");

  const meta = [
    `# ${title}`,
    "",
    "## Bridge Source",
    `- Origin: \`${ORIGIN_ID}\` (user \`${ORIGIN_USER}\`, machine \`${ORIGIN_MACHINE}\`)`,
    `- Workspace: \`${path.dirname(absolutePath)}\``,
    `- Project (decoded): \`${projectDecoded}\``,
    `- Relative path: \`${fileName}\``,
    `- Kind: \`markdown\``,
    `- Agents: claude-code`,
    `- Updated: ${updatedIso}`,
    "",
    "## Content",
    "```markdown",
    content,
    "```",
    "",
  ].join("\n");

  return frontmatter + meta;
}

function fingerprint(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

async function readMaybe(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function acquireLock() {
  await fs.mkdir(path.dirname(LOCK_PATH), { recursive: true });
  try {
    await fs.writeFile(
      LOCK_PATH,
      JSON.stringify({ pid: process.pid, at: Date.now(), origin: ORIGIN_ID }),
      {
        flag: "wx",
      },
    );
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
    // Lock exists — check if it's stale
    try {
      const raw = await fs.readFile(LOCK_PATH, "utf8");
      const parsed = JSON.parse(raw);
      if (typeof parsed.at === "number" && Date.now() - parsed.at < STALE_LOCK_MS) {
        return false;
      }
    } catch {
      // unparseable lock file — treat as stale
    }
    await fs.rm(LOCK_PATH, { force: true });
    return acquireLock();
  }
}

async function releaseLock() {
  await fs.rm(LOCK_PATH, { force: true });
}

async function appendLog(line) {
  try {
    await fs.mkdir(path.dirname(LOG_PATH), { recursive: true });
    const entry = `${new Date().toISOString()} [${ORIGIN_ID}] ${line}\n`;
    await fs.appendFile(LOG_PATH, entry, "utf8");
  } catch {
    // logging is best-effort
  }
}

async function atomicWrite(absolutePath, content) {
  const tmpPath = `${absolutePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, content, "utf8");
  await fs.rename(tmpPath, absolutePath);
}

async function listOurExistingPages() {
  const entries = await fs.readdir(SOURCES_DIR, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && e.name.startsWith(OUR_PAGE_PREFIX) && e.name.endsWith(".md"))
    .map((e) => e.name);
}

async function pruneLegacyUnnamespaced({ dryRun = false } = {}) {
  const entries = await fs.readdir(SOURCES_DIR, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const e of entries) {
    if (!e.isFile() || !e.name.startsWith(FILE_PREFIX) || !e.name.endsWith(".md")) {
      continue;
    }
    if (e.name.startsWith(OUR_PAGE_PREFIX)) {
      continue;
    }
    const abs = path.join(SOURCES_DIR, e.name);
    const content = await readMaybe(abs);
    if (content === null) {
      continue;
    }
    if (/^originId:\s/m.test(content)) {
      continue;
    }
    if (!dryRun) {
      await fs.rm(abs, { force: true });
    }
    removed += 1;
  }
  return removed;
}

async function runMirror({ dryRun = false } = {}) {
  await fs.mkdir(SOURCES_DIR, { recursive: true });
  const desiredPages = new Set();
  let mirrored = 0;
  let unchanged = 0;
  let skipped = 0;

  const projects = await listProjects();
  for (const projectDirName of projects) {
    const memFiles = await listProjectMemoryFiles(projectDirName);
    for (const file of memFiles) {
      let stat;
      try {
        stat = await fs.stat(file.absolutePath);
      } catch {
        continue;
      }
      if (stat.size === 0 || stat.size > MAX_FILE_BYTES) {
        skipped += 1;
        continue;
      }
      const content = await readMaybe(file.absolutePath);
      if (content === null || content.trim().length === 0) {
        skipped += 1;
        continue;
      }
      const pagePath = buildPagePath(projectDirName, file.relativeName);
      const pageAbs = path.join(VAULT_DIR, pagePath);
      desiredPages.add(path.basename(pagePath));

      const rendered = renderSourcePage({
        projectDirName,
        fileName: file.relativeName,
        absolutePath: file.absolutePath,
        content,
        sourceUpdatedAtMs: stat.mtimeMs,
      });

      const existing = await readMaybe(pageAbs);
      if (existing !== null && fingerprint(existing) === fingerprint(rendered)) {
        unchanged += 1;
        continue;
      }
      if (dryRun) {
        mirrored += 1;
        continue;
      }
      await atomicWrite(pageAbs, rendered);
      mirrored += 1;
    }
  }

  // Prune our origin's orphans only. Other machines own their own prefixes.
  let pruned = 0;
  const ourPages = await listOurExistingPages();
  for (const pageName of ourPages) {
    if (desiredPages.has(pageName)) {
      continue;
    }
    if (dryRun) {
      pruned += 1;
      continue;
    }
    await fs.rm(path.join(SOURCES_DIR, pageName), { force: true });
    pruned += 1;
  }

  return { mirrored, unchanged, skipped, pruned, scannedProjects: projects.length };
}

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const verbose = args.has("--verbose") || args.has("-v");
const force = args.has("--force");
const pruneLegacy = args.has("--prune-legacy");

if (!force) {
  const got = await acquireLock();
  if (!got) {
    if (verbose) {
      process.stdout.write("another mirror run is in progress; exiting\n");
    }
    process.exit(0);
  }
}

let result;
let legacyRemoved = 0;
let error = null;
try {
  result = await runMirror({ dryRun });
  if (pruneLegacy) {
    legacyRemoved = await pruneLegacyUnnamespaced({ dryRun });
  }
} catch (e) {
  error = e;
} finally {
  if (!force) {
    await releaseLock().catch(() => undefined);
  }
}

if (error) {
  await appendLog(`ERROR ${error.stack ?? error.message}`);
  process.stderr.write(`mirror error: ${error.message}\n`);
  process.exit(1);
}

const summary =
  `mirrored=${result.mirrored} unchanged=${result.unchanged} skipped=${result.skipped} ` +
  `pruned=${result.pruned} projects=${result.scannedProjects}` +
  (pruneLegacy ? ` legacyRemoved=${legacyRemoved}` : "") +
  (dryRun ? " (dry-run)" : "");
await appendLog(summary);
if (verbose || dryRun) {
  process.stdout.write(`origin=${ORIGIN_ID}\n${summary}\n`);
}
process.exit(0);
