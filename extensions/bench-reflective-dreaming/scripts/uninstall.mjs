#!/usr/bin/env node
/**
 * uninstall.mjs — Remove managed reflective-dreaming cron jobs.
 *
 * Leaves the protocol files in `~/.openclaw/wiki/main/concepts/` alone because
 * they may have been rarity-approved in Firebase; removing them would create
 * drift. Delete them manually if you're sure.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MANAGED_TAG = "[managed-by=bench-reflective-dreaming]";

async function openclaw(args) {
  const { stdout } = await execFileAsync("openclaw", args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

async function main() {
  const stdout = await openclaw(["cron", "list", "--all", "--json"]);
  const data = JSON.parse(stdout);
  const jobs = Array.isArray(data) ? data : (data.jobs ?? []);
  const ours = jobs.filter((j) => (j.description ?? "").includes(MANAGED_TAG));

  if (ours.length === 0) {
    console.log("[reflective-dreaming] nothing to uninstall.");
    return;
  }

  for (const job of ours) {
    console.log(`[reflective-dreaming] removing ${job.name} (${job.id})`);
    await openclaw(["cron", "rm", job.id]);
  }

  console.log(`[reflective-dreaming] uninstalled ${ours.length} cron job(s).`);
  console.log(
    "[reflective-dreaming] protocol files in ~/.openclaw/wiki/main/concepts/ are preserved.",
  );
}

main().catch((err) => {
  console.error(`[reflective-dreaming] uninstall failed: ${err.message ?? err}`);
  process.exit(1);
});
