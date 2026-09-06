#!/usr/bin/env node
// Captures Bench design-package proof shots: the chat surface and the
// Appearance settings page for each Bench theme family, dark and light.
// `bench` (the fork default) runs on a fresh profile with no stored settings;
// the other families arrive as synced server prefs (ui.prefs.theme) through
// the mock gateway's config.get, the same path theme-typography.e2e uses. The
// mock gateway owns its own settings key (its gateway URL differs from the page
// origin), so seeding localStorage for the page origin would not reach it.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const BENCH_THEME_FAMILIES = ["bench", "bench-garden", "bench-forge", "bench-aurelius"] as const;

const outputDir = path.resolve(".artifacts/control-ui-e2e/bench-theme-proof");
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!(await canRunPlaywrightChromium(executablePath))) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

await mkdir(outputDir, { recursive: true });
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });

function themeConfigResponse(theme: string, mode: "dark" | "light") {
  const config = { ui: { prefs: { theme, themeMode: mode } } };
  const hash = `bench-theme-proof-${theme}-${mode}`;
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

async function capture(
  family: (typeof BENCH_THEME_FAMILIES)[number],
  colorScheme: "dark" | "light",
) {
  const label = `${family}-${colorScheme}`;
  const context = await browser.newContext({
    colorScheme,
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await installMockGateway(
      page,
      family === "bench"
        ? {}
        : { methodResponses: { "config.get": themeConfigResponse(family, colorScheme) } },
    );
    await page.goto(`${server.baseUrl}chat`);
    await page.locator(".agent-chat__input").waitFor({ state: "visible" });
    const expectedTheme = colorScheme === "light" ? `${family}-light` : family;
    await page.waitForFunction(
      (expected) => document.documentElement.getAttribute("data-theme") === expected,
      expectedTheme,
    );
    await page.waitForTimeout(600);
    const resolvedTheme = await page.evaluate(() =>
      document.documentElement.getAttribute("data-theme"),
    );
    const accent = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(),
    );
    const displayFont = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--font-display").trim(),
    );
    await page.screenshot({ path: path.join(outputDir, `${label}-chat.png`) });

    await page.goto(`${server.baseUrl}settings/appearance`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outputDir, `${label}-appearance.png`) });
    console.log(JSON.stringify({ label, resolvedTheme, accent, displayFont }));
  } finally {
    await context.close();
  }
}

try {
  for (const family of BENCH_THEME_FAMILIES) {
    await capture(family, "dark");
    await capture(family, "light");
  }
  console.log(JSON.stringify({ outputDir }));
} finally {
  await browser.close();
  await server.close();
}
