import type { AnyAgentTool, OpenClawConfig } from "../api.js";
import { runChecks, type Verdict } from "./checks.js";
import type { MemoryDurabilityConfig } from "./config.js";

const MemoryDurabilitySchema = {
  type: "object",
  properties: {
    verbose: { type: "boolean", description: "Include the full per-check detail list." },
  },
  additionalProperties: false,
} as const;

function renderVerdict(v: Verdict): string {
  const flag = (s: string) =>
    s === "ok" ? "OK " : s === "fail" ? "FAIL" : s === "error" ? "ERR " : "skip";
  const head = `memory-durability: ${v.ok ? "OK" : "BROKEN"}${v.degraded ? " (degraded)" : ""} @ ${v.host} [${v.tenant}]`;
  return [head, ...v.checks.map((c) => `  [${flag(c.status)}] ${c.name}: ${c.detail}`)].join("\n");
}

// `memory_durability` — the deterministic, queryable durability verdict. Any surface (the web app, doctor,
// an agent, or the Claude operator harness) can call this for the same truth the watcher acts on.
export function createMemoryDurabilityTool(
  config: MemoryDurabilityConfig,
  _appConfig?: OpenClawConfig,
): AnyAgentTool {
  return {
    name: "memory_durability",
    label: "Memory Durability",
    description:
      "Run the Aurelius memory-plane durability sweep: store/workspace agreement, CORE.md freshness, bus liveness, live-plate duplication, and vault behind-remote. Returns ok plus a per-check verdict.",
    parameters: MemoryDurabilitySchema,
    execute: async (_toolCallId: string, rawParams: unknown) => {
      const verbose = Boolean((rawParams as { verbose?: boolean } | undefined)?.verbose);
      const verdict = runChecks({
        workspaceRoot: config.workspaceRoot,
        storeDir: config.storeDir,
        vaultRoot: config.vaultRoot,
        busLog: config.busLog,
        tenant: config.tenant,
        maxAgeHours: config.coreMaxAgeHours,
        busLogMaxAgeSec: config.busLogMaxAgeSec,
        graceMs: config.graceMs,
      });
      return {
        content: [{ type: "text", text: renderVerdict(verdict) }],
        details: verbose
          ? verdict
          : {
              ok: verdict.ok,
              degraded: verdict.degraded,
              failed: verdict.failed,
              errored: verdict.errored,
              host: verdict.host,
              tenant: verdict.tenant,
            },
      };
    },
  };
}
