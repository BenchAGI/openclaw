import type { App } from "@slack/bolt";
import { danger, getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import type { SlackMonitorContext } from "../context.js";
import { createHomeRenderCache, makeHomeCacheKey, type HomeRenderCache } from "./cache.js";
import { buildHomeFallbackView } from "./fallback-view.js";
import { loadRenderer } from "./renderer-loader.js";
import type { ResolvedSlackHomeTab, SlackHomeRenderInput, SlackHomeRenderResult } from "./types.js";

const logger = getChildLogger({ module: "slack-home" });

export interface HomeTabRuntime {
  config: ResolvedSlackHomeTab;
  cache: HomeRenderCache;
}

export function createHomeTabRuntime(config: ResolvedSlackHomeTab): HomeTabRuntime {
  return {
    config,
    cache: createHomeRenderCache({ ttlMs: config.cacheTtlMs }),
  };
}

/**
 * Register the `app_home_opened` listener on the Bolt App. Safe to call when
 * `runtime.config.enabled` is false — the registration simply never fires a
 * renderer and publishes nothing.
 */
export function registerSlackAppHomeEvents(params: {
  ctx: SlackMonitorContext;
  account: { name: string };
  runtime: HomeTabRuntime;
  trackEvent?: () => void;
}): void {
  const { ctx, account, runtime, trackEvent } = params;

  ctx.app.event("app_home_opened", async ({ event, body }) => {
    try {
      if (ctx.shouldDropMismatchedSlackEvent(body)) {
        return;
      }
      trackEvent?.();

      const evt = event as { tab?: string; user?: string; view?: { hash?: string } };
      if (evt.tab !== "home") {
        return;
      }
      if (!evt.user) {
        return;
      }

      if (!runtime.config.enabled || !runtime.config.rendererModule) {
        // Feature configured but disabled, or no module — leave tab untouched.
        return;
      }

      await publishHome({
        app: ctx.app,
        accountId: ctx.accountId,
        accountName: account.name,
        botUserId: ctx.botUserId,
        teamId: ctx.teamId,
        slackUserId: evt.user,
        runtime,
      });
    } catch (err) {
      logger.error(danger(`app_home_opened handler threw: ${String(err)}`));
    }
  });
}

async function publishHome(params: {
  app: App;
  accountId: string;
  accountName: string;
  botUserId: string;
  teamId: string;
  slackUserId: string;
  runtime: HomeTabRuntime;
}): Promise<void> {
  const { app, accountId, accountName, botUserId, teamId, slackUserId, runtime } = params;
  const generatedAt = new Date();
  const cacheKey = makeHomeCacheKey({ accountId, slackUserId });

  let result: SlackHomeRenderResult | null = runtime.cache.get(cacheKey);
  let cacheHit = result !== null;

  if (!result) {
    try {
      const renderer = await loadRenderer(runtime.config.rendererModule!);
      const input: SlackHomeRenderInput = {
        accountId,
        slackUserId,
        teamId,
        botUserId,
        generatedAt,
      };
      result = await renderer(input);
      if (!result || !Array.isArray(result.blocks)) {
        throw new Error("renderer returned invalid result (expected { blocks: [] })");
      }
      runtime.cache.set(cacheKey, result);
    } catch (err) {
      logger.warn(`[home] renderer error for ${accountId}:${slackUserId}: ${String(err)}`);
      const fallback = buildHomeFallbackView({
        accountName,
        reason: summarizeError(err),
        generatedAt,
      });
      await safePublish(app, slackUserId, fallback);
      return;
    }
  }

  const blocks = trimBlocks(result.blocks, runtime.config.maxBlocks);

  try {
    await app.client.views.publish({
      user_id: slackUserId,
      view: {
        type: "home",
        blocks: blocks as unknown as never,
        ...(result.privateMetadata ? { private_metadata: result.privateMetadata } : {}),
        ...(result.callbackId ? { callback_id: result.callbackId } : {}),
      },
    });
    logger.info(
      `[home] published account=${accountId} user=${slackUserId} blocks=${blocks.length} cacheHit=${cacheHit}`,
    );
  } catch (err) {
    logger.error(`[home] views.publish failed: ${String(err)}`);
  }
}

async function safePublish(app: App, slackUserId: string, blocks: object[]): Promise<void> {
  try {
    await app.client.views.publish({
      user_id: slackUserId,
      view: { type: "home", blocks: blocks as unknown as never },
    });
  } catch (err) {
    // Swallow — if we can't even publish the fallback there's nothing more to do.
    logger.warn(`[home] fallback publish failed: ${String(err)}`);
  }
}

function trimBlocks(blocks: object[], maxBlocks: number): object[] {
  if (blocks.length <= maxBlocks) {
    return blocks;
  }
  return blocks.slice(0, maxBlocks);
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}
