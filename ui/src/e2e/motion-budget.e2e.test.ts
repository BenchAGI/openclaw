// Control UI tests cover the motion budget: the pre-paint data-motion stamp,
// its runtime resolution, and the calm rule reaching light-DOM animations.
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

// A bare WKWebView (Tauri/wry, the Aurelius Vault) carries no browser product token.
const WKWEBVIEW_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";

let browser: Browser;
let server: ControlUiE2eServer;
const openContexts = new Set<BrowserContext>();

type MotionProbe = {
  motion: string | null;
  playState: string;
  probeDuration: string;
  probeIterations: string;
};

async function createPage(options: {
  userAgent?: string;
  reducedMotion?: "reduce" | "no-preference";
}): Promise<Page> {
  const context = await browser.newContext({
    viewport: { height: 900, width: 1280 },
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  openContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  return page;
}

/** Records the stamp as the boot script left it, before any module evaluates. */
async function tracePrePaintMotion(page: Page): Promise<() => Promise<string | null>> {
  await page.addInitScript(() => {
    document.addEventListener(
      "DOMContentLoaded",
      () => {
        (window as Window & { openclawPrePaintMotion?: string | null }).openclawPrePaintMotion =
          document.documentElement.dataset.motion ?? null;
      },
      { once: true },
    );
  });
  return () =>
    page.evaluate(
      () =>
        (window as Window & { openclawPrePaintMotion?: string | null }).openclawPrePaintMotion ??
        null,
    );
}

async function probeMotion(page: Page): Promise<MotionProbe> {
  return await page.evaluate(() => {
    const probe = document.createElement("div");
    probe.style.animation = "openclaw-motion-probe 1s linear infinite";
    document.body.append(probe);
    const style = getComputedStyle(probe);
    const result = {
      motion: document.documentElement.dataset.motion ?? null,
      playState:
        getComputedStyle(document.documentElement)
          .getPropertyValue("--control-ui-motion-play-state")
          .trim() || "running",
      probeDuration: style.animationDuration,
      probeIterations: style.animationIterationCount,
    };
    probe.remove();
    return result;
  });
}

describeControlUiE2e("Control UI motion budget E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    await browser?.close();
    await server?.close();
  });

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  async function bootAndProbe(page: Page): Promise<{ prePaint: string | null } & MotionProbe> {
    const readPrePaintMotion = await tracePrePaintMotion(page);
    await page.goto(server.baseUrl, { waitUntil: "domcontentloaded" });
    const prePaint = await readPrePaintMotion();
    await page
      .locator("openclaw-app-root, openclaw-login-gate, openclaw-app-shell")
      .first()
      .waitFor();
    return { prePaint, ...(await probeMotion(page)) };
  }

  it("keeps full motion in an ordinary browser", async () => {
    const page = await createPage({});
    const result = await bootAndProbe(page);
    expect(result.prePaint).toBe("full");
    expect(result.motion).toBe("full");
    expect(result.playState).toBe("running");
    expect(result.probeDuration).toBe("1s");
    expect(result.probeIterations).toBe("infinite");
  });

  it("boots calm inside a bare WKWebView host before first paint", async () => {
    const page = await createPage({ userAgent: WKWEBVIEW_USER_AGENT });
    const result = await bootAndProbe(page);
    expect(result.prePaint).toBe("reduced");
    expect(result.motion).toBe("reduced");
    expect(result.playState).toBe("paused");
    // Computed durations normalize to seconds; the calm rule sets 0.001ms.
    expect(Number.parseFloat(result.probeDuration)).toBeLessThan(0.001);
    expect(result.probeIterations).toBe("1");
  });

  it("boots calm under the explicit Aurelius Vault user-agent token", async () => {
    const page = await createPage({
      userAgent: `${WKWEBVIEW_USER_AGENT} Chrome/152.0.0.0 Safari/605.1.15 AureliusVault/0.2.0`,
    });
    const result = await bootAndProbe(page);
    expect(result.prePaint).toBe("reduced");
    expect(result.motion).toBe("reduced");
  });

  it("boots calm when the OS prefers reduced motion", async () => {
    const page = await createPage({ reducedMotion: "reduce" });
    const result = await bootAndProbe(page);
    expect(result.prePaint).toBe("reduced");
    expect(result.motion).toBe("reduced");
    expect(result.playState).toBe("paused");
  });
});
