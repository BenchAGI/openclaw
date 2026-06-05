// Durable sync cursor for the bench-sync plugin.
//
// Stored in OpenClaw SQLite plugin state. The meta row tracks the directive
// pull cursor + enacted-directive ring; card/proposal hash cursors and directive
// ack payloads are separate rows so growing mirrors do not hit the per-value
// plugin-state size limit.

import crypto from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import type { BenchSyncDirectiveAck } from "./client.js";

/** Per-card sync bookkeeping: content hash + monotonically increasing seq. */
export type BenchSyncCardCursor = {
  hash: string;
  seq: number;
};

/** Per-proposal mirror-up bookkeeping: last-synced content hash. */
export type BenchSyncProposalCursor = {
  hash: string;
};

export type BenchSyncCursorState = {
  /** Last-synced state per Workboard card id, keyed by gateway card id. */
  cards: Record<string, BenchSyncCardCursor>;
  /** Last-synced state per skill proposal id (mirror-up hash diff). */
  proposals: Record<string, BenchSyncProposalCursor>;
  /** Opaque directive pull cursor returned by the cloud. */
  directiveCursor: string | null;
  /** Bounded ring of directive ids already enacted (dedupe), most-recent last. */
  appliedDirectiveIds: string[];
  /** Ack payloads for ringed directives, retained so ack retries do not re-enact. */
  directiveAcks: Record<string, BenchSyncDirectiveAck>;
};

export type BenchSyncCursorMetaRow = {
  kind: "meta";
  directiveCursor: string | null;
  appliedDirectiveIds: string[];
};

export type BenchSyncCardCursorRow = {
  kind: "card";
  cardId: string;
  cursor: BenchSyncCardCursor;
};

export type BenchSyncProposalCursorRow = {
  kind: "proposal";
  proposalId: string;
  cursor: BenchSyncProposalCursor;
};

export type BenchSyncDirectiveAckRow = {
  kind: "directiveAck";
  directiveId: string;
  ack: BenchSyncDirectiveAck;
};

export type BenchSyncCursorRow =
  | BenchSyncCursorMetaRow
  | BenchSyncCardCursorRow
  | BenchSyncProposalCursorRow
  | BenchSyncDirectiveAckRow;

export type BenchSyncCursorStore = Pick<
  PluginStateKeyedStore<BenchSyncCursorRow>,
  "delete" | "entries" | "register"
>;

/** Max retained enacted-directive ids (bounded ring). */
export const MAX_APPLIED_DIRECTIVE_IDS = 500;

export const CURSOR_STATE_NAMESPACE = "cursor";
export const CURSOR_STATE_MAX_ENTRIES = 5_000;

const CURSOR_META_KEY = "meta";
const CARD_KEY_PREFIX = "card:";
const PROPOSAL_KEY_PREFIX = "proposal:";
const DIRECTIVE_ACK_KEY_PREFIX = "directive-ack:";

export function defaultCursorState(): BenchSyncCursorState {
  return {
    cards: {},
    proposals: {},
    directiveCursor: null,
    appliedDirectiveIds: [],
    directiveAcks: {},
  };
}

type CursorLogger = {
  warn?: (message: string) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceCardCursor(value: unknown): BenchSyncCardCursor | null {
  if (!isRecord(value)) {
    return null;
  }
  const hash = value.hash;
  const seq = value.seq;
  if (typeof hash !== "string" || typeof seq !== "number" || !Number.isFinite(seq)) {
    return null;
  }
  return { hash, seq };
}

function coerceProposalCursor(value: unknown): BenchSyncProposalCursor | null {
  if (!isRecord(value) || typeof value.hash !== "string") {
    return null;
  }
  return { hash: value.hash };
}

function coerceDirectiveAck(value: unknown): BenchSyncDirectiveAck | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.status === "skipped") {
    return typeof value.reason === "string" ? { status: "skipped", reason: value.reason } : null;
  }
  if (value.status === "failed") {
    if (!isRecord(value.error)) {
      return null;
    }
    const code = value.error.code;
    const message = value.error.message;
    return typeof code === "string" && typeof message === "string"
      ? { status: "failed", error: { code, message } }
      : null;
  }
  if (value.status === "applied") {
    if (value.result === undefined) {
      return { status: "applied" };
    }
    if (!isRecord(value.result)) {
      return null;
    }
    const proposalId =
      typeof value.result.proposalId === "string" ? value.result.proposalId : undefined;
    const cardId = typeof value.result.cardId === "string" ? value.result.cardId : undefined;
    const result = {
      ...(proposalId ? { proposalId } : {}),
      ...(cardId ? { cardId } : {}),
    };
    return Object.keys(result).length > 0 ? { status: "applied", result } : { status: "applied" };
  }
  return null;
}

function normalizeCursorMetaRow(value: unknown): BenchSyncCursorMetaRow | null {
  if (!isRecord(value) || value.kind !== "meta") {
    return null;
  }
  let directiveCursor: string | null = null;
  if (value.directiveCursor !== undefined && value.directiveCursor !== null) {
    if (typeof value.directiveCursor !== "string") {
      return null;
    }
    directiveCursor = value.directiveCursor;
  }
  if (
    !Array.isArray(value.appliedDirectiveIds) ||
    value.appliedDirectiveIds.some((id) => typeof id !== "string")
  ) {
    return null;
  }
  const appliedDirectiveIds = boundAppliedRing(value.appliedDirectiveIds as string[]);
  return {
    kind: "meta",
    directiveCursor,
    appliedDirectiveIds,
  };
}

function normalizeCardCursorRow(value: unknown): BenchSyncCardCursorRow | null {
  if (!isRecord(value) || value.kind !== "card" || typeof value.cardId !== "string") {
    return null;
  }
  const cursor = coerceCardCursor(value.cursor);
  if (!cursor) {
    return null;
  }
  return {
    kind: "card",
    cardId: value.cardId,
    cursor,
  };
}

function normalizeProposalCursorRow(value: unknown): BenchSyncProposalCursorRow | null {
  if (!isRecord(value) || value.kind !== "proposal" || typeof value.proposalId !== "string") {
    return null;
  }
  const cursor = coerceProposalCursor(value.cursor);
  if (!cursor) {
    return null;
  }
  return {
    kind: "proposal",
    proposalId: value.proposalId,
    cursor,
  };
}

function normalizeDirectiveAckRow(value: unknown): BenchSyncDirectiveAckRow | null {
  if (!isRecord(value) || value.kind !== "directiveAck" || typeof value.directiveId !== "string") {
    return null;
  }
  const ack = coerceDirectiveAck(value.ack);
  if (!ack) {
    return null;
  }
  return {
    kind: "directiveAck",
    directiveId: value.directiveId,
    ack,
  };
}

/** Keep only the most recent MAX_APPLIED_DIRECTIVE_IDS ids. */
export function boundAppliedRing(ids: string[]): string[] {
  if (ids.length <= MAX_APPLIED_DIRECTIVE_IDS) {
    return [...ids];
  }
  return ids.slice(ids.length - MAX_APPLIED_DIRECTIVE_IDS);
}

function pruneDirectiveAcks(
  acks: Record<string, BenchSyncDirectiveAck>,
  retainedIds: readonly string[],
): Record<string, BenchSyncDirectiveAck> {
  const retained: Record<string, BenchSyncDirectiveAck> = {};
  for (const id of retainedIds) {
    const ack = acks[id];
    if (ack) {
      retained[id] = ack;
    }
  }
  return retained;
}

/** Append an enacted directive id, deduping and keeping the ring bounded. */
export function recordAppliedDirective(
  state: BenchSyncCursorState,
  id: string,
  ack?: BenchSyncDirectiveAck,
): BenchSyncCursorState {
  const without = state.appliedDirectiveIds.filter((existing) => existing !== id);
  without.push(id);
  const appliedDirectiveIds = boundAppliedRing(without);
  const directiveAcks = pruneDirectiveAcks(
    {
      ...state.directiveAcks,
      ...(ack ? { [id]: ack } : {}),
    },
    appliedDirectiveIds,
  );
  return {
    ...state,
    appliedDirectiveIds,
    directiveAcks,
  };
}

export function hasAppliedDirective(state: BenchSyncCursorState, id: string): boolean {
  return state.appliedDirectiveIds.includes(id);
}

export function getAppliedDirectiveAck(
  state: BenchSyncCursorState,
  id: string,
): BenchSyncDirectiveAck | null {
  return state.directiveAcks[id] ?? null;
}

/**
 * Load the cursor from SQLite plugin state.
 *
 * - Missing state rows -> fresh default.
 * - Invalid rows -> delete the bad row, log a warning, and continue with the
 *   valid rows. Plugin state is the canonical store for this cursor.
 */
export async function loadCursor(
  store: BenchSyncCursorStore,
  logger?: CursorLogger,
): Promise<BenchSyncCursorState> {
  let directiveCursor: string | null = null;
  let appliedDirectiveIds: string[] = [];
  const directiveAcks: Record<string, BenchSyncDirectiveAck> = {};
  const cards: Record<string, BenchSyncCardCursor> = {};
  const proposals: Record<string, BenchSyncProposalCursor> = {};
  const invalidKeys: string[] = [];

  for (const entry of await store.entries()) {
    if (entry.key === CURSOR_META_KEY) {
      const meta = normalizeCursorMetaRow(entry.value);
      if (!meta) {
        invalidKeys.push(entry.key);
        continue;
      }
      directiveCursor = meta.directiveCursor;
      appliedDirectiveIds = meta.appliedDirectiveIds;
      continue;
    }
    if (entry.key.startsWith(CARD_KEY_PREFIX)) {
      const card = normalizeCardCursorRow(entry.value);
      if (!card) {
        invalidKeys.push(entry.key);
        continue;
      }
      cards[card.cardId] = card.cursor;
      continue;
    }
    if (entry.key.startsWith(PROPOSAL_KEY_PREFIX)) {
      const proposal = normalizeProposalCursorRow(entry.value);
      if (!proposal) {
        invalidKeys.push(entry.key);
        continue;
      }
      proposals[proposal.proposalId] = proposal.cursor;
      continue;
    }
    if (entry.key.startsWith(DIRECTIVE_ACK_KEY_PREFIX)) {
      const directiveAck = normalizeDirectiveAckRow(entry.value);
      if (!directiveAck) {
        invalidKeys.push(entry.key);
        continue;
      }
      directiveAcks[directiveAck.directiveId] = directiveAck.ack;
    }
  }

  if (invalidKeys.length > 0) {
    logger?.warn?.(
      `bench-sync: ignored ${invalidKeys.length} invalid cursor plugin-state row(s); clearing them`,
    );
    await Promise.all(invalidKeys.map((key) => store.delete(key).catch(() => false)));
  }

  return {
    cards,
    proposals,
    directiveCursor,
    appliedDirectiveIds,
    directiveAcks: pruneDirectiveAcks(directiveAcks, appliedDirectiveIds),
  };
}

/** Persist the cursor in SQLite plugin state. */
export async function saveCursor(
  store: BenchSyncCursorStore,
  state: BenchSyncCursorState,
): Promise<void> {
  const retainedCardKeys = new Set<string>();
  for (const [cardId, cursor] of Object.entries(state.cards)) {
    const key = hashedRowKey(CARD_KEY_PREFIX, cardId);
    retainedCardKeys.add(key);
    await store.register(key, {
      kind: "card",
      cardId,
      cursor,
    });
  }

  const retainedProposalKeys = new Set<string>();
  for (const [proposalId, cursor] of Object.entries(state.proposals)) {
    const key = hashedRowKey(PROPOSAL_KEY_PREFIX, proposalId);
    retainedProposalKeys.add(key);
    await store.register(key, {
      kind: "proposal",
      proposalId,
      cursor,
    });
  }

  const appliedDirectiveIds = boundAppliedRing(state.appliedDirectiveIds);
  const directiveAcks = pruneDirectiveAcks(state.directiveAcks, appliedDirectiveIds);
  const retainedDirectiveAckKeys = new Set<string>();
  for (const [directiveId, ack] of Object.entries(directiveAcks)) {
    const key = hashedRowKey(DIRECTIVE_ACK_KEY_PREFIX, directiveId);
    retainedDirectiveAckKeys.add(key);
    await store.register(key, {
      kind: "directiveAck",
      directiveId,
      ack,
    });
  }

  await store.register(CURSOR_META_KEY, {
    kind: "meta",
    directiveCursor: state.directiveCursor,
    appliedDirectiveIds,
  });

  const staleKeys = (await store.entries())
    .filter(
      (entry) =>
        (entry.key.startsWith(CARD_KEY_PREFIX) && !retainedCardKeys.has(entry.key)) ||
        (entry.key.startsWith(PROPOSAL_KEY_PREFIX) && !retainedProposalKeys.has(entry.key)) ||
        (entry.key.startsWith(DIRECTIVE_ACK_KEY_PREFIX) &&
          !retainedDirectiveAckKeys.has(entry.key)),
    )
    .map((entry) => entry.key);
  await Promise.all(staleKeys.map((key) => store.delete(key)));
}

function hashedRowKey(prefix: string, id: string): string {
  return `${prefix}${crypto.createHash("sha256").update(id).digest("hex")}`;
}
