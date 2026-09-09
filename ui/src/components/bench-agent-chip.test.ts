/* @vitest-environment jsdom */

import { html, render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import {
  BENCH_AGENT_MENU_TOGGLE_EVENT,
  type BenchAgentMenuToggleDetail,
  renderBenchAgentChip,
} from "./bench-agent-chip.ts";

describe("bench agent chip", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("paints a Bench agent with its portrait, role, and rarity", () => {
    const container = document.createElement("div");
    render(
      renderBenchAgentChip({ agentId: "cole", name: "Zig", switcherAvailable: true }),
      container,
    );
    const chip = container.querySelector<HTMLButtonElement>(".bench-agent-chip");
    expect(chip?.getAttribute("aria-label")).toBe("Zig · Switch agent");
    expect(chip?.getAttribute("style")).toContain("--agent-accent: #f59e5b");
    expect(chip?.getAttribute("style")).toContain("--agent-rarity: #a335ee");
    expect(chip?.querySelector("img")?.getAttribute("src")).toContain("agent-art/zig.png");
    expect(chip?.querySelector(".bench-agent-chip__name")?.textContent).toBe("Zig");
    expect(chip?.querySelector(".bench-agent-chip__role")?.textContent).toBe("Sales");
  });

  it("falls back to the initial for agents outside the Bench fleet", () => {
    const container = document.createElement("div");
    render(renderBenchAgentChip({ agentId: "main", name: "Main" }), container);
    const chip = container.querySelector(".bench-agent-chip");
    expect(chip?.querySelector("img")).toBeNull();
    expect(chip?.querySelector(".bench-agent-chip__initial")?.textContent).toBe("M");
    expect(chip?.querySelector(".bench-agent-chip__role")).toBeNull();
    expect(chip?.getAttribute("style")).toContain("--agent-accent: var(--accent)");
  });

  it("asks the sidebar for the agent menu with itself as the trigger", () => {
    const container = document.createElement("div");
    document.body.append(container);
    render(renderBenchAgentChip({ agentId: "aurelius", name: "Aurelius" }), container);
    const seen: BenchAgentMenuToggleDetail[] = [];
    window.addEventListener(
      BENCH_AGENT_MENU_TOGGLE_EVENT,
      (event) => seen.push((event as CustomEvent<BenchAgentMenuToggleDetail>).detail),
      { once: true },
    );
    const chip = container.querySelector<HTMLButtonElement>(".bench-agent-chip");
    chip?.click();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.trigger).toBe(chip);
  });
});

// Keep the template import used in the file for lit type inference.
void html;
