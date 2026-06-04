// Durable sync cursor for the bench-sync plugin.
//
// Stored in OpenClaw SQLite plugin state. The meta row tracks the directive
// pull cursor + applied-directive ring; card hash cursors are separate rows so
// large Workboards do not hit the per-value plugin-state size limit.

import crypto from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";

/** Per-card sync bookkeeping: content hash + monotonically increasing seq. */
export type BenchSyncCardCursor = {
  hash: string;
  seq: number;
};

export type BenchSyncCursorState = {
  /** Last-synced state per Workboard card id, keyed by gateway card id. */
  cards: Record<string, BenchSyncCardCursor>;
  /** Opaque directive pull cursor returned by the cloud. */
  directiveCursor: string | null;
  /** Bounded ring of directive ids already applied (dedupe), most-recent last. */
  appliedDirectiveIds: string[];
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

export type BenchSyncCursorRow = BenchSyncCursorMetaRow | BenchSyncCardCursorRow;

export type BenchSyncCursorStore = Pick<
  PluginStateKeyedStore<BenchSyncCursorRow>,
  "delete" | "entries" | "register"
>;

/** Max retained applied-directive ids (bounded ring). */
export const MAX_APPLIED_DIRECTIVE_IDS = 500;

export const CURSOR_STATE_NAMESPACE = "cursor";
export const CURSOR_STATE_MAX_ENTRIES = 5_000;

const CURSOR_META_KEY = "meta";
const CARD_KEY_PREFIX = "card:";

export function defaultCursorState(): BenchSyncCursorState {
  return {
    cards: {},
    directiveCursor: null,
    appliedDirectiveIds: [],
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
  return {
    kind: "meta",
    directiveCursor,
    appliedDirectiveIds: boundAppliedRing(value.appliedDirectiveIds as string[]),
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

/** Keep only the most recent MAX_APPLIED_DIRECTIVE_IDS ids. */
export function boundAppliedRing(ids: string[]): string[] {
  if (ids.length <= MAX_APPLIED_DIRECTIVE_IDS) {
    return [...ids];
  }
  return ids.slice(ids.length - MAX_APPLIED_DIRECTIVE_IDS);
}

/** Append an applied directive id, deduping and keeping the ring bounded. */
export function recordAppliedDirective(
  state: BenchSyncCursorState,
  id: string,
): BenchSyncCursorState {
  const without = state.appliedDirectiveIds.filter((existing) => existing !== id);
  without.push(id);
  return {
    ...state,
    appliedDirectiveIds: boundAppliedRing(without),
  };
}

export function hasAppliedDirective(state: BenchSyncCursorState, id: string): boolean {
  return state.appliedDirectiveIds.includes(id);
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
  const cards: Record<string, BenchSyncCardCursor> = {};
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
    if (!entry.key.startsWith(CARD_KEY_PREFIX)) {
      continue;
    }
    const card = normalizeCardCursorRow(entry.value);
    if (!card) {
      invalidKeys.push(entry.key);
      continue;
    }
    cards[card.cardId] = card.cursor;
  }

  if (invalidKeys.length > 0) {
    logger?.warn?.(
      `bench-sync: ignored ${invalidKeys.length} invalid cursor plugin-state row(s); clearing them`,
    );
    await Promise.all(invalidKeys.map((key) => store.delete(key).catch(() => false)));
  }

  return { cards, directiveCursor, appliedDirectiveIds };
}

/** Persist the cursor in SQLite plugin state. */
export async function saveCursor(
  store: BenchSyncCursorStore,
  state: BenchSyncCursorState,
): Promise<void> {
  const retainedCardKeys = new Set<string>();
  for (const [cardId, cursor] of Object.entries(state.cards)) {
    const key = cardRowKey(cardId);
    retainedCardKeys.add(key);
    await store.register(key, {
      kind: "card",
      cardId,
      cursor,
    });
  }

  await store.register(CURSOR_META_KEY, {
    kind: "meta",
    directiveCursor: state.directiveCursor,
    appliedDirectiveIds: boundAppliedRing(state.appliedDirectiveIds),
  });

  const staleKeys = (await store.entries())
    .filter((entry) => entry.key.startsWith(CARD_KEY_PREFIX) && !retainedCardKeys.has(entry.key))
    .map((entry) => entry.key);
  await Promise.all(staleKeys.map((key) => store.delete(key)));
}

function cardRowKey(cardId: string): string {
  return `${CARD_KEY_PREFIX}${crypto.createHash("sha256").update(cardId).digest("hex")}`;
}
