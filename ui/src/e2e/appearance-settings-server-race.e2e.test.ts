import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createTweakcnThemePayload } from "../test-helpers/custom-theme.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Appearance server race mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

function settingsStorageKey(): string {
  return controlUiBundledSettingsStorageKey(suite.server.baseUrl);
}

function configResponse(prefs: Record<string, unknown>, hash: string) {
  const config = { ui: { prefs } };
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

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await gateway.getRequests(method)).length, { timeout: 10_000 })
    .toBe(count);
}

async function readPersistedSettings(page: import("playwright").Page) {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }, settingsStorageKey());
}

suite.define(() => {
  it("keeps a newer server-applied theme authoritative over a delayed import", async () => {
    const replacementPayload = createTweakcnThemePayload();
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configResponse({ theme: "claw" }, "custom-theme-server-race-1"),
        "config.patch": { ok: true },
      },
    });
    await page.route("https://tweakcn.com/r/themes/replacement", async (route) => {
      await importGate;
      await route.fulfill({ json: replacementPayload });
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const themeSection = page.locator("#settings-appearance-theme");
      await themeSection.locator(".settings-theme-card--custom").click();
      const importer = page.locator(".settings-theme-import");
      await importer.locator("input").fill("replacement");
      await importer.locator("button.primary").click();
      const replacementResponse = page.waitForResponse("https://tweakcn.com/r/themes/replacement");
      await expect.poll(() => importer.locator("button.primary").isDisabled()).toBe(true);

      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse({ theme: "knot" }, "custom-theme-server-race-2"),
      );
      await gateway.emitGatewayEvent("config.changed", {
        hash: "custom-theme-server-race-2",
        path: "/tmp/openclaw.json",
        ts: Date.now(),
      });
      await waitForRequestCount(gateway, "config.get", configGetCount + 1);
      await expect
        .poll(() => themeSection.locator(".settings-theme-card--knot").getAttribute("aria-pressed"))
        .toBe("true");

      releaseImport();
      await replacementResponse;
      await expect
        .poll(async () => {
          const settings = await readPersistedSettings(page);
          return {
            hasCustomTheme: typeof settings.customTheme === "object",
            theme: settings.theme,
          };
        })
        .toEqual({ hasCustomTheme: true, theme: "knot" });
      await expect
        .poll(() => importer.locator(".settings-theme-import__message").textContent())
        .toContain("Imported");
      await expect.poll(() => importer.getByRole("status").count()).toBe(1);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    } finally {
      releaseImport();
      await context.close();
    }
  });
});
