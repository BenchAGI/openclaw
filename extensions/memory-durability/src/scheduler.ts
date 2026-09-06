import type { OpenClawPluginApi } from "../api.js";
import type { MemoryDurabilityConfig } from "./config.js";

// Mirrors memory-core's managed-dreaming cron pattern: at gateway_start we resolve the cron service from
// the hook context and reconcile a single managed job. The job runs a tiny agent turn that calls the
// deterministic `memory_durability` tool and posts a one-line alert ONLY when the plane is broken; the
// CHECK is deterministic (the tool), only the wording/delivery is agent-mediated. Fail-open throughout —
// a watcher that cannot arm must never break the gateway (backwards-compat).

const MANAGED_JOB_NAME = "memory-durability-check";

type CronSchedule = { kind: "cron"; expr: string; tz?: string };
type CronPayload = { kind: "agentTurn"; message: string; lightContext?: boolean };
type ManagedCronJobCreate = {
  name: string;
  description: string;
  enabled: boolean;
  schedule: CronSchedule;
  sessionTarget: "main" | "isolated";
  wakeMode: "now";
  payload: CronPayload;
  delivery?: { mode: "announce" | "none"; channel?: string; to?: string };
};
type ManagedCronJobLike = { id: string; name?: string; createdAtMs?: number };
type CronServiceLike = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<ManagedCronJobLike[]>;
  add: (input: ManagedCronJobCreate) => Promise<unknown>;
  update: (id: string, patch: Partial<ManagedCronJobCreate>) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;

function everyNMinutesExpr(minutes: number): string {
  const m = Math.max(1, Math.min(59, Math.floor(minutes)));
  return `*/${m} * * * *`;
}

function buildJob(config: MemoryDurabilityConfig): ManagedCronJobCreate {
  const message = [
    "You are a silent memory-durability watchdog. Call the `memory_durability` tool now.",
    "If the result `ok` is true, reply with the single character `.` and nothing else.",
    "If `ok` is false, reply with ONE line: `\u{1F534} Memory durability BROKEN` followed by the failed check names and their details.",
  ].join(" ");
  return {
    name: MANAGED_JOB_NAME,
    description: "Aurelius memory-plane durability watchdog (alerts on break).",
    enabled: true,
    schedule: { kind: "cron", expr: everyNMinutesExpr(config.intervalMinutes) },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message, lightContext: true },
    delivery: { mode: "announce", channel: config.alertChannel, to: config.alertTo },
  };
}

function resolveCronFromContext(ctx: unknown): CronServiceLike | null {
  const getCron = (ctx as { getCron?: () => CronServiceLike | null } | null)?.getCron;
  if (typeof getCron !== "function") {
    return null;
  }
  try {
    return getCron() ?? null;
  } catch {
    return null;
  }
}

async function reconcile(
  cron: CronServiceLike | null,
  config: MemoryDurabilityConfig,
  logger: Logger,
): Promise<void> {
  if (!cron) {
    logger.warn?.("memory-durability: cron service unavailable; watcher not armed this cycle.");
    return;
  }
  let existing: ManagedCronJobLike[];
  try {
    existing = (await cron.list({ includeDisabled: true })).filter(
      (j) => j.name === MANAGED_JOB_NAME,
    );
  } catch (err) {
    logger.warn?.(`memory-durability: could not list cron jobs: ${String(err)}`);
    return;
  }

  // Disabled, or no Slack destination configured -> remove the managed job (stay silent, tool still works).
  const shouldRun =
    config.enabled && config.watch && Boolean(config.alertChannel) && Boolean(config.alertTo);
  if (!shouldRun) {
    for (const job of existing) {
      try {
        await cron.remove(job.id);
      } catch (err) {
        logger.warn?.(`memory-durability: failed to remove watcher job ${job.id}: ${String(err)}`);
      }
    }
    if (existing.length) {
      logger.info?.(
        "memory-durability: watcher disabled (no destination) — removed managed job(s).",
      );
    }
    return;
  }

  const desired = buildJob(config);
  if (existing.length === 0) {
    try {
      await cron.add(desired);
      logger.info?.(
        `memory-durability: armed watcher (every ${config.intervalMinutes}m -> ${config.alertTo}).`,
      );
    } catch (err) {
      logger.warn?.(`memory-durability: failed to add watcher job: ${String(err)}`);
    }
    return;
  }
  // Keep one; update it to the desired shape, prune duplicates.
  const [primary, ...dupes] = existing.toSorted(
    (a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0),
  );
  if (!primary) {
    return;
  }
  try {
    await cron.update(primary.id, desired);
  } catch (err) {
    logger.warn?.(`memory-durability: failed to update watcher job: ${String(err)}`);
  }
  for (const d of dupes) {
    try {
      await cron.remove(d.id);
    } catch {
      /* best-effort */
    }
  }
}

export function registerMemoryDurabilityWatcher(
  api: OpenClawPluginApi,
  config: MemoryDurabilityConfig,
): void {
  // Reconcile at gateway start (cron service is available on the hook context), fail-open.
  api.on("gateway_start", async (_event, ctx) => {
    try {
      await reconcile(resolveCronFromContext(ctx), config, api.logger);
    } catch (err) {
      api.logger.error(`memory-durability: watcher reconcile failed: ${String(err)}`);
    }
  });
}
