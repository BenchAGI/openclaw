import { execFileSync } from "node:child_process";
// Durability checks for the Aurelius memory plane — the OpenClaw-native, customer-shippable twin of
// the operator-side checker (kestrel-aurelius/scripts/aurelius-memory/memory-health-check.mjs). The two
// surfaces share the SAME signals + thresholds so they link rather than diverge: this plugin runs ON the
// gateway (the brain), so it checks the SHARED memory plane (store == workspace, CORE.md freshness, bus
// liveness, plate/dup, vault behind-remote) and OMITS the Claude-TUI-only harness-mirror check.
//
// Pure functions are unit-tested; the side-effecting orchestration reads files/git and never throws.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const HOUR_MS = 3600 * 1000;

export type CheckStatus = "ok" | "fail" | "skipped" | "error";
export type Check = { name: string; status: CheckStatus; detail: string };
export type Verdict = {
  ok: boolean;
  degraded: boolean;
  failed: string[];
  errored: string[];
  host: string;
  tenant: string;
  generatedAt: string;
  checks: Check[];
};

export type CheckOptions = {
  workspaceRoot?: string;
  storeDir?: string;
  vaultRoot?: string;
  busLog?: string;
  tenant?: string;
  nowMs?: number;
  graceMs?: number;
  maxAgeHours?: number;
  busLogMaxAgeSec?: number;
  home?: string;
};

// ---- pure check logic (unit-tested) -------------------------------------------

export function sha1(buf: Buffer | string): string {
  return createHash("sha1").update(buf).digest("hex");
}

// CORE.md must be regenerated recently AND reflect the current MEMORY.md. Cadence-relative: the default
// 26h tolerates a once-daily reconcile; the 30-min reconcile sets a lower cap so the assertion tightens.
export function coreFreshnessCheck(params: {
  coreText: string | null;
  memoryMtimeMs: number | null;
  nowMs: number;
  maxAgeHours: number;
}): Check {
  const name = "core-freshness";
  const cap = Number.isFinite(params.maxAgeHours) ? params.maxAgeHours : 26;
  const m = (params.coreText ?? "").match(/Generated at:\s*([0-9TZ:.+-]+)/);
  if (!m) {
    return { name, status: "error", detail: "CORE.md has no parseable 'Generated at:' line" };
  }
  const coreMs = Date.parse(m[1] ?? "");
  if (!Number.isFinite(coreMs)) {
    return { name, status: "error", detail: `CORE.md Generated-at unparseable: ${m[1]}` };
  }
  const ageH = (params.nowMs - coreMs) / HOUR_MS;
  if (ageH > cap) {
    return {
      name,
      status: "fail",
      detail: `CORE.md not regenerated in ${ageH.toFixed(1)}h (cap ${cap}h) — reconcile may be dead`,
    };
  }
  if (
    Number.isFinite(params.memoryMtimeMs as number) &&
    (params.memoryMtimeMs as number) > coreMs
  ) {
    const lagH = ((params.memoryMtimeMs as number) - coreMs) / HOUR_MS;
    if (lagH > cap) {
      return {
        name,
        status: "fail",
        detail: `CORE.md is ${lagH.toFixed(1)}h behind MEMORY.md (cap ${cap}h)`,
      };
    }
  }
  return { name, status: "ok", detail: `CORE.md generated ${ageH.toFixed(1)}h ago` };
}

// The 120s bus syncer must be alive + converged. Reads the EXISTING refs + the sync log — never fetches.
export function busLivenessCheck(params: {
  logTail: string;
  head: string | null;
  origin: string | null;
  nowMs: number;
  maxAgeSec: number;
}): Check {
  const name = "bus-liveness";
  const cap = Number.isFinite(params.maxAgeSec) ? params.maxAgeSec : 600;
  const line = (params.logTail ?? "").trim();
  if (!line) {
    return { name, status: "skipped", detail: "no bus-sync log yet" };
  }
  const tsMatch = line.match(/^(\S+)/);
  const tsMs = tsMatch?.[1] ? Date.parse(tsMatch[1]) : Number.NaN;
  if (line.includes("CONFLICT")) {
    return {
      name,
      status: "fail",
      detail: "bus sync in CONFLICT (rebase aborted) — reconcile the store",
    };
  }
  if (Number.isFinite(tsMs)) {
    const ageS = Math.round((params.nowMs - tsMs) / 1000);
    if (ageS > cap) {
      return {
        name,
        status: "fail",
        detail: `bus-sync log stale ${ageS}s (cap ${cap}s) — syncer may be dead`,
      };
    }
    if (line.includes("WARN")) {
      return {
        name,
        status: "skipped",
        detail: `bus offline/transient (last: ${line.slice(0, 80)})`,
      };
    }
    if (params.head && params.origin && params.head !== params.origin) {
      return {
        name,
        status: "fail",
        detail: `bus store diverged: HEAD ${params.head.slice(0, 7)} != origin ${params.origin.slice(0, 7)}`,
      };
    }
    return {
      name,
      status: "ok",
      detail: `converged${params.head ? " " + params.head.slice(0, 7) : ""}, last sync ${ageS}s ago`,
    };
  }
  return {
    name,
    status: "error",
    detail: `bus-sync log line has no parseable timestamp: ${line.slice(0, 80)}`,
  };
}

// Exactly one live-plate block, and no duplicated heading lines (the union-merge duplication canary).
export function plateDuplicationCheck(params: { memoryText: string }): Check {
  const name = "plate+dup";
  const text = params.memoryText ?? "";
  if (!text) {
    return { name, status: "skipped", detail: "MEMORY.md not found" };
  }
  const starts = (text.match(/aurelius-live-plate:start/g) || []).length;
  const ends = (text.match(/aurelius-live-plate:end/g) || []).length;
  if (starts !== 1 || ends !== 1) {
    return {
      name,
      status: "fail",
      detail: `live-plate markers ${starts}/${ends} (expected 1/1) — reconcile splice broken or duplicated`,
    };
  }
  const seen = new Map<string, number>();
  for (const raw of text.split(/\r?\n/)) {
    if (!/^#{1,6}\s+\S/.test(raw)) {
      continue;
    }
    const key = raw.trim().replace(/\s+/g, " ").toLowerCase();
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, n] of seen) {
    if (n > 1) {
      return {
        name,
        status: "fail",
        detail: `duplicated heading x${n}: "${key.slice(0, 60)}" — union-merge duplication`,
      };
    }
  }
  return { name, status: "ok", detail: "one live-plate block, no duplicated headings" };
}

export function summarize(
  checks: Check[],
): Pick<Verdict, "ok" | "degraded" | "failed" | "errored"> {
  return {
    ok: !checks.some((c) => c.status === "fail"),
    degraded: checks.some((c) => c.status === "error"),
    failed: checks.filter((c) => c.status === "fail").map((c) => c.name),
    errored: checks.filter((c) => c.status === "error").map((c) => c.name),
  };
}

// ---- side-effecting orchestration (fail-open, never throws) --------------------

function readBufOrNull(p: string): Buffer | null {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

function mtimeMsOrNull(p: string): number | null {
  try {
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function lastNonEmptyLine(p: string): string {
  try {
    const lines = fs
      .readFileSync(p, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim());
    return lines[lines.length - 1] ?? "";
  } catch {
    return "";
  }
}

function gitRef(dir: string, ref: string): string | null {
  try {
    return execFileSync("git", ["-C", dir, "rev-parse", ref], {
      timeout: 4000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitBehindRemote(dir: string): number | null {
  try {
    const out = execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD..@{upstream}"], {
      timeout: 4000,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

// Read-only durability sweep of the shared memory plane. Fail-open: a check that cannot run reports
// `error` (degraded) rather than silently green — the failure mode this watchdog exists to prevent.
export function runChecks(opts: CheckOptions = {}): Verdict {
  const now = Number.isFinite(opts.nowMs as number) ? (opts.nowMs as number) : Date.now();
  const home = opts.home || os.homedir();
  const workspaceRoot =
    opts.workspaceRoot ||
    process.env.BENCH_WORKSPACE_ROOT ||
    path.join(home, "clawd", "kestrel-crew", "kestrel-aurelius");
  const storeDir =
    opts.storeDir || process.env.AURELIUS_MEMORY_STORE || path.join(home, ".aurelius-memory");
  const vaultRoot =
    opts.vaultRoot ||
    process.env.AURELIUS_VAULT_ROOT ||
    path.join(home, ".openclaw", "wiki", "main");
  const busLog = opts.busLog || path.join(home, ".openclaw", "logs", "memory-bus-sync.log");
  const tenant = opts.tenant || process.env.AURELIUS_TENANT || "tenant-zero";
  const graceMs = Number.isFinite(opts.graceMs as number) ? (opts.graceMs as number) : 150 * 1000;
  const maxAgeHours = Number.isFinite(opts.maxAgeHours as number)
    ? (opts.maxAgeHours as number)
    : Number(process.env.MEMORY_CORE_MAX_AGE_HOURS) > 0
      ? Number(process.env.MEMORY_CORE_MAX_AGE_HOURS)
      : 26;
  const busLogMaxAgeSec = Number.isFinite(opts.busLogMaxAgeSec as number)
    ? (opts.busLogMaxAgeSec as number)
    : 600;

  const wsMemory = path.join(workspaceRoot, "MEMORY.md");
  const storeMemory = path.join(storeDir, "MEMORY.md");
  const coreFile = path.join(workspaceRoot, "memory", "CORE.md");
  const checks: Check[] = [];

  // 1. store durability — workspace MEMORY.md == store MEMORY.md (the curated edit reached the bus store)
  (() => {
    const name = "store-durability";
    const wsBuf = readBufOrNull(wsMemory);
    const stBuf = readBufOrNull(storeMemory);
    if (!wsBuf || !stBuf) {
      checks.push({
        name,
        status: "skipped",
        detail: `missing copy (workspace=${Boolean(wsBuf)} store=${Boolean(stBuf)})`,
      });
      return;
    }
    const wsMtime = mtimeMsOrNull(wsMemory);
    if (Number.isFinite(wsMtime as number) && now - (wsMtime as number) < graceMs) {
      checks.push({
        name,
        status: "skipped",
        detail: "workspace MEMORY.md edited within the bus interval (in-flight)",
      });
      return;
    }
    const a = sha1(wsBuf);
    const b = sha1(stBuf);
    checks.push(
      a === b
        ? { name, status: "ok", detail: `workspace==store (${a.slice(0, 8)})` }
        : {
            name,
            status: "fail",
            detail: `workspace ${a.slice(0, 8)} != store ${b.slice(0, 8)} — edit not on the bus`,
          },
    );
  })();

  // 2. CORE.md freshness
  checks.push(
    coreFreshnessCheck({
      coreText: (readBufOrNull(coreFile) || Buffer.from("")).toString("utf8") || null,
      memoryMtimeMs: mtimeMsOrNull(wsMemory),
      nowMs: now,
      maxAgeHours,
    }),
  );

  // 3. bus liveness (existing refs + log recency, no fetch)
  checks.push(
    busLivenessCheck({
      logTail: lastNonEmptyLine(busLog),
      head: gitRef(storeDir, "HEAD"),
      origin: gitRef(storeDir, "origin/main"),
      nowMs: now,
      maxAgeSec: busLogMaxAgeSec,
    }),
  );

  // 4. plate + duplication (workspace MEMORY.md)
  checks.push(
    plateDuplicationCheck({
      memoryText: (readBufOrNull(wsMemory) || Buffer.from("")).toString("utf8"),
    }),
  );

  // 5. vault freshness — the vault git index is not behind its remote
  (() => {
    const name = "vault-freshness";
    const head = gitRef(vaultRoot, "HEAD");
    if (!head) {
      checks.push({ name, status: "skipped", detail: `vault not a git repo here (${vaultRoot})` });
      return;
    }
    const behind = gitBehindRemote(vaultRoot);
    if (behind === null) {
      checks.push({
        name,
        status: "ok",
        detail: `vault HEAD ${head.slice(0, 7)} (no upstream tracking)`,
      });
      return;
    }
    checks.push(
      behind > 0
        ? { name, status: "fail", detail: `vault index ${behind} commits behind remote` }
        : { name, status: "ok", detail: `vault behindRemote=0 (${head.slice(0, 7)})` },
    );
  })();

  return {
    ...summarize(checks),
    host: os.hostname(),
    tenant,
    generatedAt: new Date(now).toISOString(),
    checks,
  };
}
