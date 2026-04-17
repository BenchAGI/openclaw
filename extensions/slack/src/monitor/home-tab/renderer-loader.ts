import path from "node:path";
import { pathToFileURL } from "node:url";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackHomeRenderer } from "./types.js";

const logger = getChildLogger({ module: "slack-home-renderer-loader" });

/**
 * Resolve a module spec into a filesystem path, then load it via dynamic
 * import. Absolute paths are used as-is. Relative paths are resolved against
 * `process.cwd()` (typically the OpenClaw gateway's working dir).
 *
 * The module must export either a default function of type SlackHomeRenderer,
 * or a named export `renderHome` of the same type.
 *
 * Loader results are NOT cached across reloads on purpose — the gateway
 * restarts on config change, so a fresh import every boot is cheap and simple.
 * Within a single process lifetime we cache by module spec to avoid the
 * per-event dynamic-import cost.
 */

const loaderCache = new Map<string, Promise<SlackHomeRenderer>>();

export function clearRendererLoaderCache(): void {
  loaderCache.clear();
}

export async function loadRenderer(moduleSpec: string): Promise<SlackHomeRenderer> {
  const cached = loaderCache.get(moduleSpec);
  if (cached) {
    return cached;
  }

  const promise = resolveAndImport(moduleSpec);
  loaderCache.set(moduleSpec, promise);
  try {
    return await promise;
  } catch (err) {
    // Remove failed cache entry so a later config fix doesn't stay broken.
    loaderCache.delete(moduleSpec);
    throw err;
  }
}

async function resolveAndImport(moduleSpec: string): Promise<SlackHomeRenderer> {
  const resolved = resolveModulePath(moduleSpec);
  const url = pathToFileURL(resolved).href;
  logger.info(`[home] loading renderer from ${url}`);
  const mod = (await import(url)) as unknown;
  const renderer = pickRenderer(mod);
  if (!renderer) {
    throw new Error(
      `Home tab renderer module did not export a default or \`renderHome\` function: ${moduleSpec}`,
    );
  }
  return renderer;
}

function resolveModulePath(moduleSpec: string): string {
  if (path.isAbsolute(moduleSpec)) {
    return moduleSpec;
  }
  return path.resolve(process.cwd(), moduleSpec);
}

function pickRenderer(mod: unknown): SlackHomeRenderer | null {
  if (!mod || typeof mod !== "object") {
    return null;
  }
  const m = mod as Record<string, unknown>;
  if (typeof m.default === "function") {
    return m.default as SlackHomeRenderer;
  }
  if (typeof m.renderHome === "function") {
    return m.renderHome as SlackHomeRenderer;
  }
  return null;
}
