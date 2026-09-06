/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./bench-mode-switch.ts";
import type { BenchModeChangeDetail, BenchModeSwitch } from "./bench-mode-switch.ts";

const APP_HREF = "https://benchagi.com/app?agent=aurelius&from=vault";
const VAULT_HREF = "https://vault.example/";

async function mount(attributes: Record<string, string> = {}) {
  const element = document.createElement("bench-mode-switch") as HTMLElement & BenchModeSwitch;
  element.setAttribute("mode", "vault");
  element.setAttribute("vault-href", VAULT_HREF);
  element.setAttribute("app-href", APP_HREF);
  element.setAttribute("agent-id", "aurelius");
  element.setAttribute("agent-name", "Aurelius");
  element.setAttribute("agent-accent", "#e7c182");
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, value);
  }
  const navigate = vi.fn();
  element.navigate = navigate;
  document.body.append(element);
  await element.updateComplete;
  return { element, navigate };
}

describe("bench-mode-switch", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("marks the host-set mode current and links the other side", async () => {
    const { element } = await mount();
    const active = element.querySelector(".bench-mode-switch__segment--active");
    expect(active?.getAttribute("aria-current")).toBe("page");
    expect(active?.textContent).toContain("Vault");
    // The active Vault segment carries the agent accent dot.
    expect(active?.querySelector(".bench-mode-switch__dot")).not.toBeNull();
    expect(element.querySelector(".bench-mode-switch")?.getAttribute("style")).toContain(
      "--agent-accent: #e7c182",
    );
    const link = element.querySelector<HTMLAnchorElement>("a.bench-mode-switch__segment");
    expect(link?.getAttribute("href")).toBe(APP_HREF);
    expect(link?.textContent).toContain("App");
    expect(link?.querySelector(".bench-mode-switch__hint")?.textContent).toMatch(/2$/u);
  });

  it("emits a cancelable bench-mode-change before navigating", async () => {
    const { element, navigate } = await mount();
    const seen: BenchModeChangeDetail[] = [];
    element.addEventListener("bench-mode-change", (event) => {
      seen.push((event as CustomEvent<BenchModeChangeDetail>).detail);
    });
    const link = element.querySelector<HTMLAnchorElement>("a.bench-mode-switch__segment");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ mode: "app", href: APP_HREF }]);
    expect(navigate).toHaveBeenCalledWith(APP_HREF);
    await element.updateComplete;
    expect(element.getAttribute("state")).toBe("switching");
    expect(element.querySelector(".bench-mode-switch--switching")).not.toBeNull();
    expect(element.querySelector(".bench-mode-switch__progress")).not.toBeNull();
    expect(element.textContent).toContain("Opening App…");
  });

  it("stays put when a listener cancels the change", async () => {
    const { element, navigate } = await mount();
    element.addEventListener("bench-mode-change", (event) => event.preventDefault());
    element
      .querySelector<HTMLAnchorElement>("a.bench-mode-switch__segment")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).not.toHaveBeenCalled();
    expect(element.switchState).toBe("idle");
  });

  it("owns ⌘2 to open the App and treats ⌘1 as a no-op while in the Vault", async () => {
    const { element, navigate } = await mount();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "1", code: "Digit1", metaKey: true, bubbles: true }),
    );
    expect(navigate).not.toHaveBeenCalled();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true }),
    );
    expect(navigate).toHaveBeenCalledWith(APP_HREF);
    element.remove();
    navigate.mockClear();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("locks the unavailable side when the host disables the switch", async () => {
    const { element, navigate } = await mount({
      state: "disabled",
      "disabled-reason": "Finish Bench sign-in to open the App",
    });
    expect(element.querySelector("a.bench-mode-switch__segment")).toBeNull();
    const locked = element.querySelector(".bench-mode-switch__segment--disabled");
    expect(locked?.getAttribute("aria-disabled")).toBe("true");
    expect(locked?.querySelector(".bench-mode-switch__lock")).not.toBeNull();
    expect(
      element.querySelector("openclaw-tooltip")?.getAttribute("content") ??
        (element.querySelector("openclaw-tooltip") as { content?: string } | null)?.content,
    ).toBe("Finish Bench sign-in to open the App");
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "2", code: "Digit2", metaKey: true, bubbles: true }),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it("moves labels to aria-label in compact mode", async () => {
    const { element } = await mount({ compact: "" });
    const segments = [...element.querySelectorAll(".bench-mode-switch__segment")];
    expect(segments.map((segment) => segment.getAttribute("aria-label"))).toEqual(["Vault", "App"]);
    expect(element.querySelector(".bench-mode-switch__hint")).toBeNull();
  });
});
