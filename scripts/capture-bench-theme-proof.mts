#!/usr/bin/env node
// Captures Bench design-package proof shots: the chat surface and the
// Appearance settings page for each Bench theme family, dark and light.
// `bench` (the fork default) runs on a fresh profile with no stored settings;
// the other families are seeded into localStorage the way the app persists
// them, so the boot script in index.html paints them before the bundle loads.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  controlUiBundledGatewayUrl,
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
const gatewayUrl = controlUiBundledGatewayUrl(server.baseUrl);

async function capture(
  family: (typeof BENCH_THEME_FAMILIES)[number],
  colorScheme: "dark" | "light",
) {
  const label = `${family}-${colorScheme}`;
  const context = await browser.newContext({
    colorScheme,
    viewport: { width: 1440, height: 900 },
  });
  if (family !== "bench") {
    await context.addInitScript(
      ({ gatewayUrl: url, theme }) => {
        localStorage.setItem(
          `openclaw.control.settings.v1:${url}`,
          JSON.stringify({ gatewayUrl: url, theme, themeMode: "system" }),
        );
      },
      { gatewayUrl, theme: family },
    );
  }
  const page = await context.newPage();
  page.setDefaultTimeout(30_000);
  try {
    await installMockGateway(page);
    await page.goto(`${server.baseUrl}chat`);
    await page.locator(".agent-chat__input").waitFor({ state: "visible" });
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
