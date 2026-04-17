import type { SlackHomeRenderResult } from "./types.js";

/**
 * Simple per-process LRU-ish TTL cache for rendered Home views.
 * Keyed by `${accountId}:${slackUserId}`.
 *
 * Slack fires `app_home_opened` on every tab click; the cache absorbs
 * user tab-spam so the renderer isn't re-invoked on every open.
 */

interface CacheEntry {
  value: SlackHomeRenderResult;
  expiresAt: number;
}

export function createHomeRenderCache(params: { ttlMs: number; max?: number }) {
  const ttlMs = Math.max(1, params.ttlMs);
  const max = params.max ?? 500;
  const entries = new Map<string, CacheEntry>();

  function sweep() {
    if (entries.size <= max) {
      return;
    }
    // Evict oldest insertions first (Map preserves insertion order).
    const toDelete = entries.size - max;
    let i = 0;
    for (const key of entries.keys()) {
      if (i++ >= toDelete) {
        break;
      }
      entries.delete(key);
    }
  }

  return {
    get(key: string): SlackHomeRenderResult | null {
      const entry = entries.get(key);
      if (!entry) {
        return null;
      }
      if (entry.expiresAt < Date.now()) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key: string, value: SlackHomeRenderResult): void {
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      sweep();
    },
    delete(key: string): void {
      entries.delete(key);
    },
    clear(): void {
      entries.clear();
    },
    size(): number {
      return entries.size;
    },
  };
}

export type HomeRenderCache = ReturnType<typeof createHomeRenderCache>;

export function makeHomeCacheKey(params: { accountId: string; slackUserId: string }): string {
  return `${params.accountId}:${params.slackUserId}`;
}
