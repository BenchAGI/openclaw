#!/usr/bin/env node
// Captures the mascot as rendered: connect splash (no gateway) and a large
// standalone render of each mood for fidelity review.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const outputDir = path.resolve(".artifacts/control-ui-e2e/mascot-proof");
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!(await canRunPlaywrightChromium(executablePath))) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

await mkdir(outputDir, { recursive: true });
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const context = await browser.newContext({
  colorScheme: "dark",
  viewport: { width: 900, height: 700 },
});
const page = await context.newPage();
page.setDefaultTimeout(30_000);

try {
  await page.goto(server.baseUrl);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outputDir, "connect-splash.png") });

  // Big standalone mascot render for close inspection.
  await page.evaluate(() => {
    document.body.innerHTML = "";
    document.body.style.background = "#111111";
    for (const mood of ["idle", "thinking", "working", "happy"]) {
      const el = document.createElement("openclaw-mascot");
      el.setAttribute("mood", mood);
      // The size property is the sizing API; the CSS var is overwritten by
      // the component's own first update.
      (el as unknown as { size: number }).size = 320;
      document.body.append(el);
    }
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(outputDir, "mascot-moods-320px.png") });
  console.log(JSON.stringify({ outputDir }));
} finally {
  await context.close();
  await browser.close();
  await server.close();
}
