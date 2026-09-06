/* @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import "./sidebar-agent-card.ts";

type CardElement = HTMLElement & {
  agentId: string | null;
  agentName: string;
  online: boolean;
  avatarUrl: string | null;
  updateComplete: Promise<unknown>;
};

async function mountCard(patch: Partial<CardElement>) {
  const card = document.createElement("openclaw-sidebar-agent-card") as CardElement;
  Object.assign(card, { agentName: "Agent", online: false, avatarUrl: null, ...patch });
  document.body.append(card);
  await card.updateComplete;
  return card;
}

describe("sidebar agent card identity treatment", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("gives a Bench agent its halo, role eyebrow, portrait, and presence dot", async () => {
    const card = await mountCard({ agentId: "aurelius", agentName: "Aurelius", online: true });
    expect(card.querySelector(".sidebar-agent-card")?.getAttribute("style")).toContain(
      "--agent-rarity: #ff8000",
    );
    expect(
      card.querySelector(".sidebar-agent-card__avatar")?.classList.contains("bench-agent-halo"),
    ).toBe(true);
    expect(card.querySelector(".sidebar-agent-card__avatar img")?.getAttribute("src")).toContain(
      "agent-art/aurelius.png",
    );
    expect(card.querySelector(".sidebar-agent-card__role")?.textContent).toBe("Operations");
    expect(card.querySelector(".sidebar-agent-card__presence")).not.toBeNull();
  });

  it("keeps the gateway avatar over the portrait and drops the dot offline", async () => {
    const card = await mountCard({
      agentId: "cole",
      agentName: "Zig",
      avatarUrl: "data:image/png;base64,QUJD",
      online: false,
    });
    expect(card.querySelector(".sidebar-agent-card__avatar img")?.getAttribute("src")).toBe(
      "data:image/png;base64,QUJD",
    );
    expect(card.querySelector(".sidebar-agent-card__presence")).toBeNull();
  });

  it("leaves customer agents on the plain upstream row", async () => {
    const card = await mountCard({ agentId: "main", agentName: "Main", online: true });
    expect(card.querySelector(".sidebar-agent-card__role")).toBeNull();
    expect(card.querySelector(".sidebar-agent-card__avatar img")).toBeNull();
    expect(card.querySelector(".sidebar-agent-card__avatar-text")?.textContent).toBe("");
    expect(card.querySelector(".sidebar-agent-card")?.getAttribute("style")).toContain(
      "--agent-accent: var(--accent)",
    );
  });
});
