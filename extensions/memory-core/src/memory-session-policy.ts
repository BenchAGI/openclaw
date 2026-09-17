import {
  asNullableRecord,
  normalizeStringEntries,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { listMemoryEntryOrigins, type MemoryEntryOrigin } from "./memory-entry-origins.js";

/** A reversible learning hold. It never tombstones, deletes, or rewrites evidence. */
export type MemorySessionPolicy = {
  sessionIds: string[];
  requireSessionLineage: boolean;
};

export function resolveMemorySessionPolicy(
  pluginConfig?: Record<string, unknown>,
): MemorySessionPolicy | undefined {
  const policy = asNullableRecord(pluginConfig?.memoryPolicy);
  const excluded = asNullableRecord(policy?.excludeSessions)?.sessionIds;
  const sessionIds = Array.isArray(excluded)
    ? normalizeStringEntries(excluded.filter((value): value is string => typeof value === "string"))
    : [];
  const requireSessionLineage = policy?.requireSessionLineage === true;
  return sessionIds.length > 0 || requireSessionLineage
    ? { sessionIds, requireSessionLineage }
    : undefined;
}

export function memorySessionOriginsExclusionReason(
  origins: readonly Pick<MemoryEntryOrigin, "agentId" | "sessionId" | "originClass">[],
  policy?: MemorySessionPolicy,
): string | undefined {
  if (!policy) {
    return undefined;
  }
  if (origins.some((origin) => policy.sessionIds.includes(origin.sessionId))) {
    return "session quarantine";
  }
  if (policy.requireSessionLineage) {
    if (origins.length === 0) {
      return "session lineage required";
    }
    if (
      origins.some((origin) => origin.originClass !== "owner" && origin.originClass !== "agent")
    ) {
      return "untrusted session lineage";
    }
  }
  return undefined;
}

/** Resolve host-owned lineage; candidate prose/provenance cannot assert its own admission. */
export function getMemoryEntryPolicyDecisions(params: {
  agentIds: readonly string[];
  entryKeys: readonly string[];
  policy?: MemorySessionPolicy;
}): Map<string, string> {
  const rejected = new Map<string, string>();
  if (!params.policy || params.entryKeys.length === 0) {
    return rejected;
  }
  const origins = new Map<string, MemoryEntryOrigin[]>();
  for (const agentId of new Set(params.agentIds)) {
    for (const origin of listMemoryEntryOrigins({ agentId, entryKeys: params.entryKeys })) {
      const bucket = origins.get(origin.entryKey) ?? [];
      bucket.push(origin);
      origins.set(origin.entryKey, bucket);
    }
  }
  for (const key of params.entryKeys) {
    const reason = memorySessionOriginsExclusionReason(origins.get(key) ?? [], params.policy);
    if (reason) {
      rejected.set(key, reason);
    }
  }
  return rejected;
}
