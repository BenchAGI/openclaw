#!/usr/bin/env node
// Captures Bench design-package proof shots: the chat surface and the
// Appearance settings page rendering the new default bench theme, dark and
// light, on a fresh profile (no stored settings).
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const outputDir = path.resolve(".artifacts/control-ui-e2e/bench-theme-proof");
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!(await canRunPlaywrightChromium(executablePath))) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

await mkdir(outputDir, { recursive: true });
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });

async function capture(colorScheme: "dark" | "light", label: string) {
  const context = await browser.newContext({
    colorScheme,
    viewport: { width: 1440, height: 900 },
  });
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
    await page.screenshot({ path: path.join(outputDir, `${label}-chat.png`) });

    await page.goto(`${server.baseUrl}settings/appearance`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outputDir, `${label}-appearance.png`) });
    console.log(JSON.stringify({ label, resolvedTheme, accent }));
  } finally {
    await context.close();
  }
}

try {
  await capture("dark", "bench-dark");
  await capture("light", "bench-light");
  console.log(JSON.stringify({ outputDir }));
} finally {
  await browser.close();
  await server.close();
}
