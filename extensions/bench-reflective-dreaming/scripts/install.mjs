#!/usr/bin/env node
/**
 * install.mjs — Install / reconcile bench-reflective-dreaming.
 *
 * Idempotent:
 *   1. Copies assets/prompts/*.md into the vault concepts dir (only if content
 *      differs by sha256, so re-runs are cheap and don't needlessly touch mtimes).
 *   2. Migrates any un-tagged "dream-<agent>" / "fleet-canon" / "memory-consolidation"
 *      cron jobs (the orphan ones created before this extension existed) into
 *      plugin-managed ones by recreating them with the managed-by tag in the
 *      description.
 *   3. Reconciles managed cron jobs from defaults/cron-schedule.json: adds what's
 *      missing, updates what's changed, removes what's no longer in defaults.
 *
 * Run it from anywhere:
 *   node scripts/install.mjs
 *
 * Or via the bash wrapper:
 *   bash scripts/install.sh
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = path.resolve(__dirname, "..");
const ASSETS_DIR = path.join(EXT_ROOT, "assets", "prompts");
const DEFAULTS_PATH = path.join(EXT_ROOT, "defaults", "cron-schedule.json");

const MANAGED_TAG = "[managed-by=bench-reflective-dreaming]";
const HOME = os.homedir();
const VAULT_CONCEPTS_DIR = path.join(HOME, ".openclaw", "wiki", "main", "concepts");

// ─── Helpers ──────────────────────────────────────────────────────────

async function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath);
  } catch (err) {
    if (err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

async function openclaw(args) {
  const { stdout } = await execFileAsync("openclaw", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

// ─── Step 1: sync protocol assets to vault ────────────────────────────

async function syncProtocolAssets() {
  await fs.mkdir(VAULT_CONCEPTS_DIR, { recursive: true });
  const entries = await fs.readdir(ASSETS_DIR);
  let written = 0;
  let unchanged = 0;
  for (const name of entries) {
    if (!name.endsWith(".md")) {
      continue;
    }
    const src = path.join(ASSETS_DIR, name);
    const dst = path.join(VAULT_CONCEPTS_DIR, name);
    const srcBuf = await fs.readFile(src);
    const dstBuf = await readFileIfExists(dst);
    if (dstBuf && (await sha256(srcBuf)) === (await sha256(dstBuf))) {
      unchanged += 1;
      continue;
    }
    await fs.writeFile(dst, srcBuf);
    written += 1;
    console.log(`[reflective-dreaming] installed concepts/${name}`);
  }
  console.log(`[reflective-dreaming] protocols: ${written} written, ${unchanged} unchanged`);
}

// ─── Cron schedule helpers ────────────────────────────────────────────

function agentDreamJobSpec(agentCfg, timezone) {
  const id = agentCfg.id;
  return {
    name: `dream-${id}`,
    description: `Nightly reflective dream pass for ${id}. ${MANAGED_TAG}`,
    agent: id,
    cron: `${agentCfg.minute} 2 * * *`,
    tz: timezone,
    sessionKey: `agent:${id}:dream`,
    timeoutSeconds: agentCfg.timeoutSeconds ?? 900,
    model: agentCfg.model,
    message:
      `DREAM CYCLE. Your agent id is ${id}. Read ${path.join(VAULT_CONCEPTS_DIR, "dreaming-protocol.md")} ` +
      `and follow it exactly. Use today's local date (YYYY-MM-DD) for your dream log path: ` +
      `${path.join(HOME, ".openclaw", "wiki", "main", "dreams", id)}/<YYYY-MM-DD>.md. ` +
      `Work autonomously and write the file; do not call external services. Exit when done. ` +
      `Budget: 30k tokens, 15 min.`,
  };
}

function canonJobSpec(canonCfg, timezone) {
  const agent = canonCfg.coordinatorAgent;
  return {
    name: "fleet-canon",
    description: `Nightly fleet canon synthesis after per-agent dreams. ${MANAGED_TAG}`,
    agent,
    cron: canonCfg.cron,
    tz: timezone,
    sessionKey: `agent:${agent}:canon`,
    timeoutSeconds: canonCfg.timeoutSeconds ?? 1200,
    message:
      `FLEET CANON. Read ${path.join(VAULT_CONCEPTS_DIR, "fleet-canon-protocol.md")} ` +
      `and follow it exactly. You are the fleet coordinator tonight. Read tonight's dream logs under ` +
      `${path.join(HOME, ".openclaw", "wiki", "main", "dreams")}/*/<YYYY-MM-DD>.md (use today's local date), ` +
      `then write the canon entry at ${path.join(HOME, ".openclaw", "wiki", "main", "canon")}/<YYYY-MM-DD>.md. ` +
      `Work autonomously. Do not call external services. Budget: 50k tokens, 20 min.`,
  };
}

function consolidationJobSpec(cfg, timezone) {
  const agent = cfg.consolidatorAgent;
  return {
    name: "memory-consolidation",
    description: `Nightly memory consolidation: prune duplicates, stage risky patches. ${MANAGED_TAG}`,
    agent,
    cron: cfg.cron,
    tz: timezone,
    sessionKey: `agent:${agent}:consolidation`,
    timeoutSeconds: cfg.timeoutSeconds ?? 900,
    message:
      `CONSOLIDATION. Read ${path.join(VAULT_CONCEPTS_DIR, "memory-consolidation-protocol.md")} ` +
      `and follow it exactly. You are the consolidator. Apply safe merges automatically, stage risky ones. ` +
      `Write audit to ${path.join(HOME, ".openclaw", "wiki", "main", "dreams", "consolidation")}/<YYYY-MM-DD>.md ` +
      `(use today's local date). Work autonomously. Budget: 40k tokens, 15 min.`,
  };
}

function equivalent(existing, desired) {
  if (!existing) {
    return false;
  }
  const existingCron = existing.schedule?.expr ?? "";
  const existingTz = existing.schedule?.tz ?? "";
  const existingMsg = existing.payload?.message ?? "";
  const existingTimeout = existing.payload?.timeoutSeconds ?? 0;
  const existingDesc = existing.description ?? "";
  return (
    existing.agentId === desired.agent &&
    existing.name === desired.name &&
    existing.sessionKey === desired.sessionKey &&
    existingCron === desired.cron &&
    existingTz === desired.tz &&
    existingMsg === desired.message &&
    existingTimeout === desired.timeoutSeconds &&
    existingDesc.includes(MANAGED_TAG)
  );
}

async function listAllCronJobs() {
  const stdout = await openclaw(["cron", "list", "--all", "--json"]);
  const data = JSON.parse(stdout);
  return Array.isArray(data) ? data : (data.jobs ?? []);
}

async function removeCronJob(id) {
  await openclaw(["cron", "rm", id]);
}

async function addCronJob(spec) {
  const args = [
    "cron",
    "add",
    "--agent",
    spec.agent,
    "--name",
    spec.name,
    "--description",
    spec.description,
    "--cron",
    spec.cron,
    "--tz",
    spec.tz,
    "--session-key",
    spec.sessionKey,
    "--message",
    spec.message,
    "--timeout-seconds",
    String(spec.timeoutSeconds),
    "--wake",
    "now",
    "--light-context",
    "--json",
  ];
  if (spec.model) {
    args.push("--model", spec.model);
  }
  await openclaw(args);
}

// ─── Step 2+3: reconcile cron jobs ────────────────────────────────────

async function reconcileCronJobs(config) {
  const desiredSpecs = [
    ...config.perAgent.map((a) => agentDreamJobSpec(a, config.timezone)),
    canonJobSpec(config.canon, config.timezone),
    consolidationJobSpec(config.consolidation, config.timezone),
  ];
  const desiredByName = new Map(desiredSpecs.map((s) => [s.name, s]));

  const all = await listAllCronJobs();

  // Candidates to consider as "ours": name matches one of ours OR description contains managed tag.
  const ours = all.filter(
    (j) => desiredByName.has(j.name) || (j.description ?? "").includes(MANAGED_TAG),
  );

  let added = 0;
  let updated = 0;
  let removed = 0;

  // Remove duplicates and stale jobs
  const seen = new Map(); // name -> first kept job
  for (const job of ours) {
    const desired = desiredByName.get(job.name);
    if (!desired) {
      console.log(`[reflective-dreaming] removing stale cron ${job.name} (${job.id})`);
      await removeCronJob(job.id);
      removed += 1;
      continue;
    }
    if (seen.has(job.name)) {
      console.log(`[reflective-dreaming] removing duplicate cron ${job.name} (${job.id})`);
      await removeCronJob(job.id);
      removed += 1;
      continue;
    }
    seen.set(job.name, job);
  }

  // Add missing + update mismatched (delete+add for simplicity; cron edit API is patch-only)
  for (const [name, desired] of desiredByName) {
    const existing = seen.get(name);
    if (!existing) {
      console.log(`[reflective-dreaming] adding cron ${name}`);
      await addCronJob(desired);
      added += 1;
      continue;
    }
    if (!equivalent(existing, desired)) {
      console.log(`[reflective-dreaming] reconciling cron ${name} (was ${existing.id})`);
      await removeCronJob(existing.id);
      await addCronJob(desired);
      updated += 1;
    }
  }

  console.log(`[reflective-dreaming] cron: ${added} added, ${updated} updated, ${removed} removed`);
}

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const configRaw = await fs.readFile(DEFAULTS_PATH, "utf8");
  const config = JSON.parse(configRaw);
  if (config.enabled === false) {
    console.log("[reflective-dreaming] disabled in defaults — nothing to do.");
    return;
  }
  await syncProtocolAssets();
  await reconcileCronJobs(config);
  console.log("[reflective-dreaming] install complete.");
}

main().catch((err) => {
  console.error(`[reflective-dreaming] install failed: ${err.message ?? err}`);
  process.exit(1);
});
