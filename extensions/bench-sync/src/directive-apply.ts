// Directive pull/apply + skill-proposal mirror-up (B3).
// .oxlintrc disables two type-aware rules for this file because tsgolint
// does not return on this projection module; tsgo + Vitest cover the contracts.
//
// Two responsibilities, both gated behind skillSync.enabled:
//
// 1. DOWN — pull `skill_proposal_decision` directives and enact them through
//    the Skill Workshop service. The cloud decision route is admin-gated, so
//    the operator decision arriving here IS the approval: enacting it locally
//    is the approved path. We do NOT bypass the scanner — applySkillProposal
//    re-runs the scanner on apply and quarantines on a dirty bundle, so the
//    security gate still fires. Each directive is acked applied/failed/skipped
//    and recorded in the dedupe ring so a re-delivery is a no-op.
//
// 2. UP — mirror skill proposals to the cloud. Pending proposals mirror only
//    when skillSync.mirrorPendingUp is on; STATUS CHANGES (applied / rejected /
//    quarantined / stale) always mirror when skillSync is enabled, because the
//    cloud auto-consumes decisions on status-change sync (belt-and-suspenders).
//    Both use the same content-hash diff against the cursor.

import { createHash } from "node:crypto";
import type {
  SkillProposalActionInput,
  SkillProposalApplyResult,
  SkillProposalKind,
  SkillProposalManifest,
  SkillProposalManifestEntry,
  SkillProposalRecord,
  SkillProposalScan,
  SkillProposalScannerState,
  SkillProposalStatus,
  SkillProposalSupportFile,
} from "openclaw/plugin-sdk/skill-workshop-runtime";
import {
  BenchSyncClientError,
  type BenchSyncClient,
  type BenchSyncDirectiveAck,
} from "./client.js";
import {
  getAppliedDirectiveAck,
  hasAppliedDirective,
  recordAppliedDirective,
  saveCursor,
  type BenchSyncCursorState,
  type BenchSyncCursorStore,
} from "./cursor.js";

/** Max proposals per mirror-up POST — must stay <= the cloud cap (50). */
export const PROPOSAL_MIRROR_BATCH_SIZE = 50;

/** PROPOSAL.md bound (bytes) for the mirror payload. */
const MAX_PROPOSAL_MARKDOWN_BYTES = 40_000;

type DirectiveLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/** Cloud decision action carried by a skill_proposal_decision directive. */
export type SkillProposalDecisionAction = "apply" | "reject" | "quarantine";
export type {
  SkillProposalActionInput,
  SkillProposalApplyResult,
  SkillProposalKind,
  SkillProposalManifest,
  SkillProposalManifestEntry,
  SkillProposalRecord,
  SkillProposalScan,
  SkillProposalScannerState,
  SkillProposalStatus,
  SkillProposalSupportFile,
};

/** Minimal shape of a pulled directive (the cloud SyncDirective contract). */
export type PulledDirective = {
  id: string;
  type: "skill_proposal_decision";
  idempotencyKey: string;
  payload: {
    proposalId: string;
    action: SkillProposalDecisionAction;
    reason: string | null;
    decidedAt: number;
  };
};

type PulledDirectivesResponse = {
  directives: PulledDirective[];
  cursor?: string | null;
};

/**
 * Workshop service surface the directive loop needs. Injected so the module is
 * decoupled from core and unit-testable; index.ts wires the real service.
 */
export type SkillWorkshopContext = {
  /** Single-workspace v1: the default agent's workspace dir. */
  workspaceDir: string;
  applyProposal: (input: SkillProposalActionInput) => Promise<SkillProposalApplyResult>;
  rejectProposal: (input: SkillProposalActionInput) => Promise<SkillProposalRecord>;
  quarantineProposal: (input: SkillProposalActionInput) => Promise<SkillProposalRecord>;
  /** Manifest of proposals scoped to the workspace. */
  listProposals: (options: { workspaceDir: string }) => Promise<SkillProposalManifest>;
  /** Full record + PROPOSAL.md body for a proposal (mirror-up payload). */
  inspectProposal: (
    proposalId: string,
    options: { workspaceDir: string },
  ) => Promise<{ record: SkillProposalRecord; content: string } | null>;
};

// ── DOWN: directive pull/apply ───────────────────────────────────────────────

function isPulledDirectivesResponse(value: unknown): value is PulledDirectivesResponse {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Array.isArray(record.directives);
}

function isSkillProposalDirective(value: unknown): value is PulledDirective {
  if (!value || typeof value !== "object") {
    return false;
  }
  const directive = value as Record<string, unknown>;
  if (typeof directive.id !== "string" || directive.type !== "skill_proposal_decision") {
    return false;
  }
  const payload = directive.payload;
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const p = payload as Record<string, unknown>;
  return (
    typeof p.proposalId === "string" &&
    (p.action === "apply" || p.action === "reject" || p.action === "quarantine")
  );
}

/** Redact an error to a safe code+message envelope (never secrets). */
function toAckError(err: unknown): { code: string; message: string } {
  if (err instanceof BenchSyncClientError) {
    return { code: err.code ?? "client_error", message: err.message };
  }
  if (err instanceof Error) {
    return { code: "apply_failed", message: err.message };
  }
  return { code: "apply_failed", message: "skill proposal decision failed" };
}

async function enactDirective(
  directive: PulledDirective,
  skillsCtx: SkillWorkshopContext,
): Promise<BenchSyncDirectiveAck> {
  const { proposalId, action, reason } = directive.payload;
  const input: SkillProposalActionInput = {
    workspaceDir: skillsCtx.workspaceDir,
    proposalId,
    ...(reason ? { reason } : {}),
  };
  try {
    if (action === "apply") {
      // applySkillProposal re-runs the scanner internally; a dirty bundle
      // self-quarantines and throws — we never bypass the gate.
      const result = await skillsCtx.applyProposal(input);
      return { status: "applied", result: { proposalId: result.record.id } };
    }
    if (action === "reject") {
      const record = await skillsCtx.rejectProposal(input);
      return { status: "applied", result: { proposalId: record.id } };
    }
    const record = await skillsCtx.quarantineProposal(input);
    return { status: "applied", result: { proposalId: record.id } };
  } catch (err) {
    return { status: "failed", error: toAckError(err) };
  }
}

export type RunDirectiveTickArgs = {
  client: BenchSyncClient;
  cursorStore: { store: BenchSyncCursorStore; state: BenchSyncCursorState };
  skillsCtx: SkillWorkshopContext;
  logger?: DirectiveLogger;
  signal?: AbortSignal;
};

export type DirectiveTickResult = {
  pulled: number;
  applied: number;
  failed: number;
  skipped: number;
};

/**
 * Pull and enact skill_proposal_decision directives.
 *
 * - A directive already in the dedupe ring is re-acked with its cached outcome
 *   when available and NOT re-enacted (idempotent re-delivery).
 * - On success the directive is acked 'applied' and ringed with that ack.
 * - On enact failure the directive is acked 'failed' AND still ringed: the
 *   cloud decision is terminal, so retrying it forever would loop. The failure
 *   is surfaced to the operator via the ack; re-deciding produces a NEW
 *   directive id, which is not in the ring.
 * - The directive pull cursor from the response is persisted so the next pull
 *   resumes after the last batch.
 */
export async function runDirectiveTick(args: RunDirectiveTickArgs): Promise<DirectiveTickResult> {
  const { client, cursorStore, skillsCtx, logger, signal } = args;
  const raw = await client.pullDirectives(
    { types: ["skill_proposal_decision"], cursor: cursorStore.state.directiveCursor },
    { signal },
  );
  if (!isPulledDirectivesResponse(raw)) {
    logger?.warn?.("bench-sync: directive pull returned an unexpected shape; skipping");
    return { pulled: 0, applied: 0, failed: 0, skipped: 0 };
  }

  const result: DirectiveTickResult = { pulled: 0, applied: 0, failed: 0, skipped: 0 };
  let state = cursorStore.state;

  for (const directive of raw.directives) {
    if (signal?.aborted) {
      break;
    }
    if (!isSkillProposalDirective(directive)) {
      logger?.warn?.("bench-sync: skipping malformed skill_proposal_decision directive");
      continue;
    }
    result.pulled += 1;

    if (hasAppliedDirective(state, directive.id)) {
      // Already enacted in a prior tick — resend the cached ack if we have it,
      // otherwise preserve the old ring-only behavior for pre-ack-cache state.
      const cachedAck = getAppliedDirectiveAck(state, directive.id) ?? {
        status: "skipped" as const,
        reason: "already applied",
      };
      await client.ackDirective(directive.id, cachedAck, { signal });
      result.skipped += 1;
      continue;
    }

    const ack = await enactDirective(directive, skillsCtx);
    // Ring the id whether it applied or failed (failure is terminal). Persist
    // before the ack so a transient ack failure retries this exact ack without
    // re-enacting the local decision.
    state = recordAppliedDirective(state, directive.id, ack);
    cursorStore.state = state;
    await saveCursor(cursorStore.store, state);
    await client.ackDirective(directive.id, ack, { signal });
    if (ack.status === "applied") {
      result.applied += 1;
    } else {
      result.failed += 1;
      logger?.warn?.(
        `bench-sync: directive ${directive.id} failed (${
          ack.status === "failed" ? ack.error.code : "unknown"
        })`,
      );
    }
  }

  // Persist the pull cursor + the updated ring.
  if (raw.cursor !== undefined) {
    state = { ...state, directiveCursor: raw.cursor ?? null };
  }
  cursorStore.state = state;
  await saveCursor(cursorStore.store, state);

  logger?.debug?.(
    `bench-sync: directives — pulled ${result.pulled}, applied ${result.applied}, ` +
      `failed ${result.failed}, skipped ${result.skipped}`,
  );
  return result;
}

// ── UP: skill-proposal mirror ────────────────────────────────────────────────

/** The cloud SkillProposal mirror payload (matches lib/skill-proposals/types). */
export type ProjectedSkillProposal = {
  proposalId: string;
  name: string;
  description: string;
  status: SkillProposalStatus;
  kind: "create" | "update";
  targetSkillRef: string | null;
  targetHash: string | null;
  proposalMarkdown: string;
  supportFiles: Array<{
    path: string;
    folder: SkillProposalSupportFolder;
    bytes: number;
    hash: string;
  }>;
  scanner: {
    status: "clean" | "flagged" | "failed";
    findings: Array<{ ruleId: string; severity: string; message: string }>;
  };
  createdByActor: string | null;
  gatewayUpdatedAt: number;
};

const SKILL_PROPOSAL_SUPPORT_FOLDERS = [
  "assets",
  "examples",
  "references",
  "scripts",
  "templates",
] as const;

type SkillProposalSupportFolder = (typeof SKILL_PROPOSAL_SUPPORT_FOLDERS)[number];

function isSkillProposalSupportFolder(value: string): value is SkillProposalSupportFolder {
  return (SKILL_PROPOSAL_SUPPORT_FOLDERS as readonly string[]).includes(value);
}

function boundBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  const truncated = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  return truncated.replace(/�+$/u, "");
}

function projectScanner(scan: SkillProposalScan): ProjectedSkillProposal["scanner"] {
  const status =
    scan.state === "failed" || (scan.state === "quarantined" && scan.critical > 0)
      ? "failed"
      : scan.state === "pending" || scan.state === "quarantined" || scan.findings.length > 0
        ? "flagged"
        : "clean";
  return {
    status,
    // Findings carry rule + severity + message only — no file paths/evidence,
    // which could leak workspace structure.
    findings: scan.findings.map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      message: finding.message,
    })),
  };
}

function projectSupportFiles(
  files: SkillProposalSupportFile[] | undefined,
): ProjectedSkillProposal["supportFiles"] {
  if (!files) {
    return [];
  }
  // METADATA ONLY — path/size/hash. File bytes NEVER cross the wire.
  return files.flatMap((file) => {
    const folder = file.path.split("/", 1)[0] ?? "";
    if (!isSkillProposalSupportFolder(folder)) {
      return [];
    }
    return [{ path: file.path, folder, bytes: file.sizeBytes, hash: file.hash }];
  });
}

/** Project a workshop record (+ PROPOSAL.md) into the cloud mirror payload. */
export function projectSkillProposal(
  record: SkillProposalRecord,
  proposalMarkdown: string,
): ProjectedSkillProposal {
  return {
    proposalId: record.id,
    name: record.target.skillName,
    description: record.description,
    status: record.status,
    kind: record.kind,
    targetSkillRef: record.kind === "update" ? record.target.skillFile : null,
    targetHash: record.target.currentContentHash ?? null,
    proposalMarkdown: boundBytes(proposalMarkdown, MAX_PROPOSAL_MARKDOWN_BYTES),
    supportFiles: projectSupportFiles(record.supportFiles),
    scanner: projectScanner(record.scan),
    createdByActor: record.origin?.agentId ?? record.createdBy ?? null,
    gatewayUpdatedAt: Date.parse(record.updatedAt) || 0,
  };
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).toSorted()) {
      sorted[key] = sortKeysDeep(record[key]);
    }
    return sorted;
  }
  return value;
}

export function computeProposalHash(projected: ProjectedSkillProposal): string {
  return createHash("sha256")
    .update(JSON.stringify(sortKeysDeep(projected)))
    .digest("hex");
}

/** A proposal is a status-change worth mirroring if it left 'pending'. */
function isTerminalStatus(status: SkillProposalStatus): boolean {
  return status !== "pending";
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export type RunProposalMirrorTickArgs = {
  client: BenchSyncClient;
  cursorStore: { store: BenchSyncCursorStore; state: BenchSyncCursorState };
  skillsCtx: SkillWorkshopContext;
  /** When false, pending proposals are NOT mirrored (status changes still are). */
  mirrorPendingUp: boolean;
  logger?: DirectiveLogger;
  signal?: AbortSignal;
};

export type ProposalMirrorTickResult = {
  considered: number;
  changed: number;
  batches: number;
};

function shouldMirror(entry: SkillProposalManifestEntry, mirrorPendingUp: boolean): boolean {
  // Status changes (applied/rejected/quarantined/stale) always mirror; pending
  // only when mirrorPendingUp is on.
  if (isTerminalStatus(entry.status)) {
    return true;
  }
  return mirrorPendingUp;
}

/**
 * Mirror skill proposals up to the cloud. Hash-diffs each candidate against the
 * cursor's `proposals` map and only POSTs changed ones, batched <= the cloud
 * cap. The cursor advances only after a batch POSTs successfully.
 */
export async function runProposalMirrorTick(
  args: RunProposalMirrorTickArgs,
): Promise<ProposalMirrorTickResult> {
  const { client, cursorStore, skillsCtx, mirrorPendingUp, logger, signal } = args;
  const manifest = await skillsCtx.listProposals({ workspaceDir: skillsCtx.workspaceDir });
  const candidates = manifest.proposals.filter((entry) => shouldMirror(entry, mirrorPendingUp));

  const changed: Array<{ id: string; payload: ProjectedSkillProposal; hash: string }> = [];
  for (const entry of candidates) {
    if (signal?.aborted) {
      break;
    }
    const inspected = await skillsCtx.inspectProposal(entry.id, {
      workspaceDir: skillsCtx.workspaceDir,
    });
    if (!inspected) {
      continue;
    }
    const payload = projectSkillProposal(inspected.record, inspected.content);
    const hash = computeProposalHash(payload);
    const previous = cursorStore.state.proposals[entry.id];
    if (previous && previous.hash === hash) {
      continue;
    }
    changed.push({ id: entry.id, payload, hash });
  }

  if (changed.length === 0) {
    logger?.debug?.("bench-sync: proposal mirror — no changed proposals");
    return { considered: candidates.length, changed: 0, batches: 0 };
  }

  const batches = chunk(changed, PROPOSAL_MIRROR_BATCH_SIZE);
  let batchesSent = 0;
  const nextProposals = { ...cursorStore.state.proposals };
  for (const batch of batches) {
    if (signal?.aborted) {
      break;
    }
    await client.postSkillProposals({ proposals: batch.map((item) => item.payload) }, { signal });
    batchesSent += 1;
    for (const item of batch) {
      nextProposals[item.id] = { hash: item.hash };
    }
    // Persist incrementally so a mid-run failure does not re-send the batches
    // that already landed.
    cursorStore.state = { ...cursorStore.state, proposals: nextProposals };
    await saveCursor(cursorStore.store, cursorStore.state);
  }

  logger?.debug?.(
    `bench-sync: proposal mirror pushed ${changed.length} proposal(s) in ${batchesSent} batch(es)`,
  );
  return { considered: candidates.length, changed: changed.length, batches: batchesSent };
}
