import { buildPluginConfigSchema, z, type OpenClawPluginConfigSchema } from "../api.js";

// All optional with safe defaults so the plugin is backwards-compatible: a gateway that adds it with no
// config still works (checks the standard paths, watcher off until a channel is configured).
export const memoryDurabilityConfigSchema: OpenClawPluginConfigSchema = buildPluginConfigSchema(
  z.object({
    enabled: z.boolean().default(true),
    // Paths to the memory plane. Default to the tenant-zero (Aurelius) layout; customers override per-tenant.
    workspaceRoot: z.string().optional(),
    storeDir: z.string().optional(),
    vaultRoot: z.string().optional(),
    busLog: z.string().optional(),
    tenant: z.string().optional(),
    // Thresholds (env-overridable too).
    coreMaxAgeHours: z.number().positive().default(26),
    busLogMaxAgeSec: z.number().positive().default(600),
    graceMs: z.number().nonnegative().default(150_000),
    // Watcher: a managed cron job that runs the check and yells to Slack on a break.
    watch: z.boolean().default(true),
    intervalMinutes: z.number().int().min(1).default(15),
    // Slack alarm destination. When unset, the watcher stays silent (queryable tool still works).
    alertChannel: z.string().optional(), // e.g. "slack"
    alertTo: z.string().optional(), // e.g. "#the_forge" or a channel id
  }),
);

export type MemoryDurabilityConfig = {
  enabled: boolean;
  workspaceRoot?: string;
  storeDir?: string;
  vaultRoot?: string;
  busLog?: string;
  tenant?: string;
  coreMaxAgeHours: number;
  busLogMaxAgeSec: number;
  graceMs: number;
  watch: boolean;
  intervalMinutes: number;
  alertChannel?: string;
  alertTo?: string;
};

const DEFAULTS: MemoryDurabilityConfig = {
  enabled: true,
  coreMaxAgeHours: 26,
  busLogMaxAgeSec: 600,
  graceMs: 150_000,
  watch: true,
  intervalMinutes: 15,
};

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveMemoryDurabilityConfig(
  raw?: Record<string, unknown>,
): MemoryDurabilityConfig {
  const c = (raw ?? {}) as Record<string, unknown>;
  return {
    enabled: c.enabled !== false,
    workspaceRoot: str(c.workspaceRoot),
    storeDir: str(c.storeDir),
    vaultRoot: str(c.vaultRoot),
    busLog: str(c.busLog),
    tenant: str(c.tenant),
    coreMaxAgeHours: num(c.coreMaxAgeHours, DEFAULTS.coreMaxAgeHours),
    busLogMaxAgeSec: num(c.busLogMaxAgeSec, DEFAULTS.busLogMaxAgeSec),
    graceMs:
      Number.isFinite(Number(c.graceMs)) && Number(c.graceMs) >= 0
        ? Number(c.graceMs)
        : DEFAULTS.graceMs,
    watch: c.watch !== false,
    intervalMinutes: Math.max(1, Math.floor(num(c.intervalMinutes, DEFAULTS.intervalMinutes))),
    alertChannel: str(c.alertChannel),
    alertTo: str(c.alertTo),
  };
}
