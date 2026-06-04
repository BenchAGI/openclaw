// Workboard up-mirror (B2).
//
// Projects local Workboard cards into the Bench cloud agent-tasks contract and
// pushes changed cards up via the bench-sync client. The projection enforces
// the gateway-side hard-privacy rules:
//   - cards labeled `internal` (or metadata.visibility === 'internal') NEVER
//     leave the machine (projectCardForCloud returns null);
//   - claim tokens are stripped (only ownership metadata crosses the wire);
//   - attachment blobs never ship (refs/metadata only, and only when cheap).
//
// Change detection is a content-hash diff against the durable cursor. A card is
// only POSTed when its projected content hash differs from the last-synced
// hash, so an unchanged board does zero network work. Batches respect the
// cloud schema's 200-cards-per-call cap. POST failures do NOT advance the
// cursor (the card is retried next tick); a consecutive-failure counter
// stretches a skip-N-ticks gate so a persistently failing cloud is not hammered
// every interval.

import { createHash } from "node:crypto";
import type { WorkboardCard, WorkboardComment, WorkboardLink } from "../../workboard/src/types.js";
import type { BenchSyncClient } from "./client.js";
import { BenchSyncClientError } from "./client.js";
import {
  saveCursor,
  type BenchSyncCardCursor,
  type BenchSyncCursorState,
  type BenchSyncCursorStore,
} from "./cursor.js";

/** Max cards per POST — must stay <= the cloud schema's maxCardsPerSync (200). */
export const MIRROR_BATCH_SIZE = 200;

/** Cap the consecutive-failure backoff so the loop keeps probing. */
export const MIRROR_MAX_BACKOFF_SKIPS = 8;

/** Bounded notes length so a single card cannot bloat the payload. */
const MAX_NOTES_BYTES = 8_000;

/** Bounded comment body length. */
const MAX_COMMENT_BODY_BYTES = 4_000;

type MirrorLogger = {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/** Minimal read surface this module needs from the Workboard store. */
export type WorkboardCardSource = {
  list: () => Promise<WorkboardCard[]>;
};

/** Sanitized claim — owner/timestamps/stale only. NEVER carries a token. */
export type ProjectedClaim = {
  owner: string;
  claimedAt: number;
  lastHeartbeatAt?: number | null;
  stale?: boolean;
};

export type ProjectedComment = {
  id?: string;
  author?: string;
  body: string;
  at?: number;
  kind?: "comment" | "handoff";
};

export type ProjectedAttempt = {
  engine?: string;
  mode?: string;
  model?: string;
  runId?: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  failureCount?: number;
};

export type ProjectedRef = {
  kind: string;
  label: string;
  ref: string;
  at: number;
};

export type ProjectedDiagnostic = {
  code: string;
  detail: string;
  at: number;
};

/** The A2 agent-task card payload shape (matches agentTaskCardSchema). */
export type ProjectedCard = {
  gatewayCardId: string;
  boardId?: string | null;
  title: string;
  notes?: string;
  status: WorkboardCard["status"];
  priority: WorkboardCard["priority"];
  labels?: string[];
  assigneeAgentId?: string | null;
  claim?: ProjectedClaim | null;
  linkedRunId?: string | null;
  linkedSessionKey?: string | null;
  blockedReason?: string | null;
  comments?: ProjectedComment[];
  attempts?: ProjectedAttempt[];
  parentTaskIds?: string[];
  childTaskIds?: string[];
  proofRefs?: ProjectedRef[];
  artifactRefs?: ProjectedRef[];
  diagnostics?: ProjectedDiagnostic[];
  gatewayUpdatedAt: number;
  syncCursor?: number;
};

function isInternalCard(card: WorkboardCard): boolean {
  if (card.labels?.includes("internal")) {
    return true;
  }
  // `metadata.visibility` is not in the Workboard type today, but the privacy
  // contract treats it as authoritative if a future build sets it. Read it
  // defensively without widening the public type.
  const visibility = (card.metadata as { visibility?: unknown } | undefined)?.visibility;
  return visibility === "internal";
}

function boundBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  // Trim by bytes, then drop any trailing partial UTF-8 sequence.
  const truncated = Buffer.from(value, "utf8").subarray(0, maxBytes).toString("utf8");
  return truncated.replace(/�+$/u, "");
}

function projectComment(comment: WorkboardComment, fallbackAuthor: string): ProjectedComment {
  // Workboard comments carry no author/kind; default to the card's agent and
  // 'comment'. Handoff-style notes are not distinguishable in the source today,
  // so everything maps to 'comment' (the cloud highlights 'handoff' when set).
  return {
    id: comment.id,
    author: fallbackAuthor,
    body: boundBytes(comment.body, MAX_COMMENT_BODY_BYTES),
    at: comment.createdAt,
    kind: "comment",
  };
}

function collectLinkedIds(
  links: WorkboardLink[] | undefined,
  type: WorkboardLink["type"],
): string[] {
  if (!links) {
    return [];
  }
  const ids: string[] = [];
  for (const link of links) {
    if (link.type === type && link.targetCardId) {
      ids.push(link.targetCardId);
    }
  }
  return ids;
}

/**
 * Project a Workboard card into the cloud agent-task payload.
 *
 * Returns null for internal-only cards — they never leave the machine.
 */
export function projectCardForCloud(card: WorkboardCard): ProjectedCard | null {
  if (isInternalCard(card)) {
    return null;
  }

  const assignee = card.agentId ?? null;
  const fallbackAuthor = card.agentId ?? "agent";
  const metadata = card.metadata;

  const projected: ProjectedCard = {
    gatewayCardId: card.id,
    boardId: metadata?.automation?.boardId ?? null,
    title: card.title,
    status: card.status,
    priority: card.priority,
    assigneeAgentId: assignee,
    gatewayUpdatedAt: card.updatedAt,
  };

  if (card.notes) {
    projected.notes = boundBytes(card.notes, MAX_NOTES_BYTES);
  }
  if (card.labels && card.labels.length > 0) {
    projected.labels = [...card.labels];
  }
  if (card.runId) {
    projected.linkedRunId = card.runId;
  }
  if (card.sessionKey) {
    projected.linkedSessionKey = card.sessionKey;
  }

  const claim = metadata?.claim;
  if (claim) {
    // Strip the token. Only owner + timestamps + derived staleness cross the
    // wire. `stale` is derived from the Workboard stale-state marker the host
    // sets on the card metadata.
    const sanitized: ProjectedClaim = {
      owner: claim.ownerId,
      claimedAt: claim.claimedAt,
      lastHeartbeatAt: claim.lastHeartbeatAt,
      stale: Boolean(metadata?.stale),
    };
    projected.claim = sanitized;
  }

  if (metadata?.comments && metadata.comments.length > 0) {
    projected.comments = metadata.comments.map((comment) =>
      projectComment(comment, fallbackAuthor),
    );
  }

  if (metadata?.attempts && metadata.attempts.length > 0) {
    projected.attempts = metadata.attempts.map((attempt) => {
      const entry: ProjectedAttempt = {};
      if (attempt.engine) {
        entry.engine = attempt.engine;
      }
      if (attempt.mode) {
        entry.mode = attempt.mode;
      }
      if (attempt.model) {
        entry.model = attempt.model;
      }
      if (attempt.runId) {
        entry.runId = attempt.runId;
      }
      if (attempt.status) {
        entry.status = attempt.status;
      }
      if (attempt.startedAt !== undefined) {
        entry.startedAt = attempt.startedAt;
      }
      if (attempt.endedAt !== undefined) {
        entry.endedAt = attempt.endedAt;
      }
      return entry;
    });
    if (metadata.failureCount !== undefined) {
      // Surface the rolling failure count on the most-recent attempt so it
      // stays visible to operators in the cloud.
      const last = projected.attempts.at(-1);
      if (last) {
        last.failureCount = metadata.failureCount;
      }
    }
  }

  const parentTaskIds = collectLinkedIds(metadata?.links, "parent");
  if (parentTaskIds.length > 0) {
    projected.parentTaskIds = parentTaskIds;
  }
  const childTaskIds = collectLinkedIds(metadata?.links, "child");
  if (childTaskIds.length > 0) {
    projected.childTaskIds = childTaskIds;
  }

  if (metadata?.proof && metadata.proof.length > 0) {
    projected.proofRefs = metadata.proof.map((entry) => ({
      kind: entry.status,
      label: entry.label ?? entry.command ?? entry.note ?? "proof",
      ref: entry.url ?? entry.command ?? entry.id,
      at: entry.createdAt,
    }));
  }

  if (metadata?.artifacts && metadata.artifacts.length > 0) {
    projected.artifactRefs = metadata.artifacts.map((entry) => ({
      kind: entry.mimeType ?? "artifact",
      label: entry.label ?? entry.path ?? "artifact",
      // refs/metadata only — never the blob. Prefer a URL, then a path ref.
      ref: entry.url ?? entry.path ?? entry.id,
      at: entry.createdAt,
    }));
  }

  if (metadata?.diagnostics && metadata.diagnostics.length > 0) {
    projected.diagnostics = metadata.diagnostics.map((entry) => ({
      code: entry.kind,
      detail: entry.detail,
      at: entry.lastSeenAt,
    }));
  }

  // NB: attachment blobs are intentionally omitted entirely. We do not even
  // ship attachment metadata refs here — the cloud contract has no attachment
  // field, and the privacy rule forbids blob bytes leaving the machine.

  return projected;
}

/** Recursively sort object keys so JSON.stringify is order-independent. */
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

/** Stable sha256 over the projected card (key order irrelevant). */
export function computeContentHash(projected: ProjectedCard): string {
  const canonical = JSON.stringify(sortKeysDeep(projected));
  return createHash("sha256").update(canonical).digest("hex");
}

function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

export type RunWorkboardMirrorTickArgs = {
  store: WorkboardCardSource;
  client: BenchSyncClient;
  cursorStore: { store: BenchSyncCursorStore; state: BenchSyncCursorState };
  logger?: MirrorLogger;
  signal?: AbortSignal;
};

export type WorkboardMirrorTickResult = {
  /** Cards considered (after dropping internal-only). */
  projected: number;
  /** Cards whose content hash changed and were pushed. */
  changed: number;
  /** Number of POST batches sent. */
  batches: number;
  /** True when the tick was skipped by the backoff gate. */
  skipped: boolean;
  /** True when a POST failed (cursor not advanced for that batch). */
  failed: boolean;
};

/**
 * In-memory backoff state. Kept outside the cursor (it is transient, not a
 * sync checkpoint): a consecutive-failure counter that gates how many ticks to
 * skip before retrying, capped at MIRROR_MAX_BACKOFF_SKIPS.
 */
export type MirrorBackoffState = {
  consecutiveFailures: number;
  skipTicksRemaining: number;
};

export function createMirrorBackoffState(): MirrorBackoffState {
  return { consecutiveFailures: 0, skipTicksRemaining: 0 };
}

function backoffSkipsFor(consecutiveFailures: number): number {
  // 1 failure -> skip 1 tick, 2 -> 2, ... capped.
  return Math.min(consecutiveFailures, MIRROR_MAX_BACKOFF_SKIPS);
}

/**
 * Run one mirror tick: list -> project -> hash-diff -> batch POST changed
 * cards -> persist cursor. Advances the cursor only for batches that POST
 * successfully. On BenchSyncClientError it records a failure and arms the
 * skip-N-ticks backoff gate; the loop's isolation handles the retry next tick.
 */
export async function runWorkboardMirrorTick(
  args: RunWorkboardMirrorTickArgs,
  backoff: MirrorBackoffState = createMirrorBackoffState(),
): Promise<WorkboardMirrorTickResult> {
  if (backoff.skipTicksRemaining > 0) {
    backoff.skipTicksRemaining -= 1;
    args.logger?.debug?.(
      `bench-sync: workboard mirror backing off (${backoff.skipTicksRemaining} skip(s) left)`,
    );
    return { projected: 0, changed: 0, batches: 0, skipped: true, failed: false };
  }

  const { store, client, cursorStore, logger, signal } = args;
  const cards = await store.list();

  const changedCards: Array<{ id: string; payload: ProjectedCard; hash: string; seq: number }> = [];
  // Monotonic seq: continue from the max seq already recorded in the cursor.
  let nextSeq = 0;
  for (const entry of Object.values(cursorStore.state.cards)) {
    if (entry.seq > nextSeq) {
      nextSeq = entry.seq;
    }
  }

  for (const card of cards) {
    const payload = projectCardForCloud(card);
    if (!payload) {
      continue;
    }
    // Hash the seq-less projection: syncCursor is a per-push monotonic counter,
    // not card content, so it must not participate in change detection (else
    // every card would always look "changed").
    const hash = computeContentHash(payload);
    const previous = cursorStore.state.cards[card.id];
    if (previous && previous.hash === hash) {
      continue;
    }
    nextSeq += 1;
    const seq = nextSeq;
    changedCards.push({ id: card.id, payload: { ...payload, syncCursor: seq }, hash, seq });
  }

  const projectedCount = changedCards.length;
  if (projectedCount === 0) {
    logger?.debug?.("bench-sync: workboard mirror — no changed cards");
    return { projected: 0, changed: 0, batches: 0, skipped: false, failed: false };
  }

  const batches = chunk(changedCards, MIRROR_BATCH_SIZE);
  let batchesSent = 0;
  const nextCardCursors: Record<string, BenchSyncCardCursor> = { ...cursorStore.state.cards };

  try {
    for (const batch of batches) {
      if (signal?.aborted) {
        break;
      }
      await client.postAgentTaskCards({ cards: batch.map((item) => item.payload) }, { signal });
      batchesSent += 1;
      for (const item of batch) {
        nextCardCursors[item.id] = { hash: item.hash, seq: item.seq };
      }
    }
  } catch (err) {
    if (err instanceof BenchSyncClientError) {
      backoff.consecutiveFailures += 1;
      backoff.skipTicksRemaining = backoffSkipsFor(backoff.consecutiveFailures);
      logger?.warn?.(
        `bench-sync: workboard mirror POST failed (${err.message}); cursor not advanced, ` +
          `retrying after ${backoff.skipTicksRemaining} skip(s)`,
      );
      // Persist any cursors advanced by batches that DID succeed before the
      // failure so already-pushed cards are not re-sent next tick.
      if (batchesSent > 0) {
        cursorStore.state = { ...cursorStore.state, cards: nextCardCursors };
        await saveCursor(cursorStore.store, cursorStore.state);
      }
      return {
        projected: projectedCount,
        changed: batchesSent === 0 ? 0 : batchesSent * MIRROR_BATCH_SIZE,
        batches: batchesSent,
        skipped: false,
        failed: true,
      };
    }
    throw err;
  }

  // Success: clear backoff and persist the advanced cursor.
  backoff.consecutiveFailures = 0;
  backoff.skipTicksRemaining = 0;
  cursorStore.state = { ...cursorStore.state, cards: nextCardCursors };
  await saveCursor(cursorStore.store, cursorStore.state);

  logger?.debug?.(
    `bench-sync: workboard mirror pushed ${projectedCount} changed card(s) in ${batchesSent} batch(es)`,
  );
  return {
    projected: projectedCount,
    changed: projectedCount,
    batches: batchesSent,
    skipped: false,
    failed: false,
  };
}
