import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!(await canRunPlaywrightChromium(executablePath))) throw new Error("no chromium");
const png = await readFile("ui/public/app-art/aurelius-mascot.png");
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 1360, height: 720 } });
await page.addInitScript("globalThis.__name = (fn) => fn;");
await page.goto("about:blank");
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
await page.evaluate((src) => {
  document.body.style.margin = "0";
  document.body.style.display = "flex";
  const sizes = [640, 320, 120, 48];
  for (const size of sizes) {
    const cell = document.createElement("div");
    cell.style.cssText = `width:${size + 40}px;height:720px;background:#111111;display:flex;align-items:center;justify-content:center;`;
    const img = document.createElement("img");
    img.src = src;
    img.style.width = `${size}px`;
    img.style.height = `${size}px`;
    cell.append(img);
    document.body.append(cell);
  }
}, dataUrl);
await page.waitForTimeout(600);
await page.screenshot({ path: "/tmp/mascot-on-dark.png" });
await browser.close();
console.log("ok");
