import type { SlackHomeTabConfig } from "openclaw/plugin-sdk/config-runtime";
import type { ResolvedSlackHomeTab } from "./types.js";

const DEFAULT_CACHE_TTL_SECONDS = 60;
const DEFAULT_MAX_BLOCKS = 100;
const HARD_BLOCK_CAP = 100; // Slack limit

export function resolveHomeTabConfig(raw: SlackHomeTabConfig | undefined): ResolvedSlackHomeTab {
  const enabled = raw?.enabled === true;
  const rendererModule =
    typeof raw?.rendererModule === "string" && raw.rendererModule.trim().length > 0
      ? raw.rendererModule.trim()
      : null;

  const rawTtl = typeof raw?.cacheTtlSeconds === "number" ? raw.cacheTtlSeconds : NaN;
  const ttlSeconds = Number.isFinite(rawTtl) && rawTtl > 0 ? rawTtl : DEFAULT_CACHE_TTL_SECONDS;

  const rawMax = typeof raw?.maxBlocks === "number" ? raw.maxBlocks : NaN;
  const maxBlocks = Math.min(
    HARD_BLOCK_CAP,
    Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_BLOCKS,
  );

  return {
    enabled: enabled && rendererModule !== null,
    rendererModule,
    cacheTtlMs: ttlSeconds * 1000,
    maxBlocks,
  };
}
