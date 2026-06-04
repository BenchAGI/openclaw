// Durable sync cursor for the bench-sync plugin.
//
// Stored as JSON at <stateDir>/bench-sync/cursor.json. Writes are atomic
// (tmp file + rename, via the plugin-sdk json-store helper). Loads fall back
// to a fresh default when the file is missing; a corrupt file is renamed aside
// to cursor.json.bak and a fresh cursor is started (with a warn log).

import { promises as fs } from "node:fs";
import path from "node:path";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";

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

/** Max retained applied-directive ids (bounded ring). */
export const MAX_APPLIED_DIRECTIVE_IDS = 500;

const CURSOR_DIR_NAME = "bench-sync";
const CURSOR_FILE_NAME = "cursor.json";

export function defaultCursorState(): BenchSyncCursorState {
  return {
    cards: {},
    directiveCursor: null,
    appliedDirectiveIds: [],
  };
}

export function cursorFilePath(stateDir: string): string {
  return path.join(stateDir, CURSOR_DIR_NAME, CURSOR_FILE_NAME);
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

/** Validate/normalize a parsed value into a cursor state, or null if invalid. */
export function normalizeCursorState(value: unknown): BenchSyncCursorState | null {
  if (!isRecord(value)) {
    return null;
  }
  const cards: Record<string, BenchSyncCardCursor> = {};
  if (value.cards !== undefined) {
    if (!isRecord(value.cards)) {
      return null;
    }
    for (const [cardId, raw] of Object.entries(value.cards)) {
      const card = coerceCardCursor(raw);
      if (!card) {
        return null;
      }
      cards[cardId] = card;
    }
  }

  let directiveCursor: string | null = null;
  if (value.directiveCursor !== undefined && value.directiveCursor !== null) {
    if (typeof value.directiveCursor !== "string") {
      return null;
    }
    directiveCursor = value.directiveCursor;
  }

  let appliedDirectiveIds: string[] = [];
  if (value.appliedDirectiveIds !== undefined) {
    if (
      !Array.isArray(value.appliedDirectiveIds) ||
      value.appliedDirectiveIds.some((id) => typeof id !== "string")
    ) {
      return null;
    }
    appliedDirectiveIds = boundAppliedRing(value.appliedDirectiveIds as string[]);
  }

  return { cards, directiveCursor, appliedDirectiveIds };
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
 * Load the cursor from disk.
 *
 * - Missing file → fresh default.
 * - Corrupt/invalid file → rename aside to cursor.json.bak, log a warning,
 *   and return a fresh default.
 */
export async function loadCursor(
  stateDir: string,
  logger?: CursorLogger,
): Promise<BenchSyncCursorState> {
  const filePath = cursorFilePath(stateDir);
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return defaultCursorState();
    }
    // Unreadable for some other reason — start fresh rather than crash the loop.
    logger?.warn?.(`bench-sync: failed to read cursor; starting fresh: ${describeError(err)}`);
    return defaultCursorState();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCorruptCursor(filePath, logger, "invalid JSON");
    return defaultCursorState();
  }

  const normalized = normalizeCursorState(parsed);
  if (!normalized) {
    await quarantineCorruptCursor(filePath, logger, "invalid shape");
    return defaultCursorState();
  }
  return normalized;
}

/** Persist the cursor atomically (tmp file + rename, 0600 perms). */
export async function saveCursor(stateDir: string, state: BenchSyncCursorState): Promise<void> {
  const filePath = cursorFilePath(stateDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeJsonFileAtomically(filePath, {
    ...state,
    appliedDirectiveIds: boundAppliedRing(state.appliedDirectiveIds),
  });
}

async function quarantineCorruptCursor(
  filePath: string,
  logger: CursorLogger | undefined,
  why: string,
): Promise<void> {
  const backupPath = `${filePath}.bak`;
  try {
    await fs.rename(filePath, backupPath);
    logger?.warn?.(
      `bench-sync: corrupt cursor (${why}); moved aside to ${backupPath} and starting fresh`,
    );
  } catch (err) {
    logger?.warn?.(
      `bench-sync: corrupt cursor (${why}); failed to move aside (${describeError(err)}); starting fresh`,
    );
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
