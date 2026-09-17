import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!canRunPlaywrightChromium(executablePath)) {
  throw new Error("no chromium");
}
const server = await startControlUiE2eServer(undefined, { source: true });
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
await page.addInitScript("globalThis.__name = (fn) => fn;");
await page.goto(server.baseUrl);
await page.waitForTimeout(1200);
const geometry = await page.evaluate(async () => {
  document.body.innerHTML = "";
  document.body.style.background = "#111";
  const el = document.createElement("openclaw-mascot");
  (el as HTMLElement).style.setProperty("--openclaw-mascot-size", "320px");
  document.body.append(el);
  await new Promise((resolve) => {
    setTimeout(resolve, 800);
  });
  const host = el as HTMLElement & { renderRoot?: ShadowRoot; size?: number };
  const canvas = host.renderRoot?.querySelector<HTMLCanvasElement>("canvas");
  return {
    hostClientWidth: host.clientWidth,
    hostClientHeight: host.clientHeight,
    canvasBackingWidth: canvas?.width,
    canvasClientWidth: canvas?.clientWidth,
    devicePixelRatio: window.devicePixelRatio,
    sizeProp: host.size,
  };
});
console.log(JSON.stringify(geometry));
await browser.close();
await server.close();
