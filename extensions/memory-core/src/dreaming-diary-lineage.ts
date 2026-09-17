import { createHash } from "node:crypto";
import { readMemoryCoreWorkspaceEntries, writeMemoryCoreWorkspaceEntry } from "./dreaming-state.js";
import { listMemoryEntryOrigins, type MemoryEntryOrigin } from "./memory-entry-origins.js";
import {
  memorySessionOriginsExclusionReason,
  type MemorySessionPolicy,
} from "./memory-session-policy.js";

const DIARY_LINEAGE_NAMESPACE = "dreaming-diary-lineage";
const MAX_DIARY_ORIGINS = 4096;
type DiaryOrigin = Pick<MemoryEntryOrigin, "agentId" | "sessionId" | "originClass">;
export type DreamDiaryLineage = {
  contentHash: string;
  sourceEntryKeys: string[];
  origins: DiaryOrigin[];
  complete: boolean;
};

export function dreamDiaryContentHash(block: string): string {
  return createHash("sha256").update(block.trim()).digest("hex");
}

export async function readDreamDiaryLineage(
  workspaceDir: string,
): Promise<Map<string, DreamDiaryLineage>> {
  const entries = await readMemoryCoreWorkspaceEntries<DreamDiaryLineage>({
    workspaceDir,
    namespace: DIARY_LINEAGE_NAMESPACE,
  });
  return new Map(entries.map(({ key, value }) => [key, value]));
}

export function dreamDiaryLineageExclusionReason(
  lineage: DreamDiaryLineage | undefined,
  policy?: MemorySessionPolicy,
): string | undefined {
  if (!policy) {
    return undefined;
  }
  if (!lineage || !lineage.complete) {
    return "diary session lineage unavailable";
  }
  return memorySessionOriginsExclusionReason(lineage.origins, policy);
}

/** Called only by the host publisher while holding the workspace lock, never by a text parser. */
export async function reserveDreamDiaryLineage(params: {
  workspaceDir: string;
  agentIds: readonly string[];
  block: string;
  sourceEntryKeys: readonly string[];
  parentLineages: readonly (DreamDiaryLineage | undefined)[];
}): Promise<DreamDiaryLineage> {
  const sourceEntryKeys = [...new Set(params.sourceEntryKeys)];
  const sourceOrigins = params.agentIds.flatMap((agentId) =>
    listMemoryEntryOrigins({ agentId, entryKeys: sourceEntryKeys }),
  );
  const attributedKeys = new Set(sourceOrigins.map((origin) => origin.entryKey));
  const contentHash = dreamDiaryContentHash(params.block);
  const previous = (await readDreamDiaryLineage(params.workspaceDir)).get(contentHash);
  const allParents = [...params.parentLineages, ...(previous ? [previous] : [])];
  const originMap = new Map<string, DiaryOrigin>();
  for (const { agentId, sessionId, originClass } of [
    ...sourceOrigins,
    ...allParents.flatMap((parent) => parent?.origins ?? []),
  ]) {
    originMap.set(JSON.stringify([agentId, sessionId, originClass]), {
      agentId,
      sessionId,
      originClass,
    });
  }
  const lineage: DreamDiaryLineage = {
    contentHash,
    sourceEntryKeys: sourceEntryKeys.slice(0, MAX_DIARY_ORIGINS),
    origins: [...originMap.values()].slice(0, MAX_DIARY_ORIGINS),
    complete:
      sourceEntryKeys.length > 0 &&
      sourceEntryKeys.length <= MAX_DIARY_ORIGINS &&
      sourceEntryKeys.every((key) => attributedKeys.has(key)) &&
      allParents.every((parent) => parent?.complete === true) &&
      originMap.size <= MAX_DIARY_ORIGINS,
  };
  // Reserve before artifact publication. A failed write can leave metadata without
  // text, never apparently clean text without metadata. No existing record is deleted.
  await writeMemoryCoreWorkspaceEntry({
    workspaceDir: params.workspaceDir,
    namespace: DIARY_LINEAGE_NAMESPACE,
    key: contentHash,
    value: lineage,
  });
  return lineage;
}
