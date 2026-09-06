/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it } from "vitest";
import { i18n } from "../../../i18n/index.ts";
import { renderWelcomeState, resolveWelcomeAgentId } from "./chat-welcome.ts";

function mountWelcome(sessionKey: string, assistantAvatar: string | null = null) {
  const container = document.createElement("div");
  render(
    renderWelcomeState({
      assistantName: "Agent",
      assistantAvatar,
      sessionKey,
      onDraftChange: () => undefined,
      onSend: () => undefined,
    }),
    container,
  );
  return container;
}

describe("chat welcome Bench identity", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  it("reads the welcome agent from the session key, then the host default", () => {
    expect(resolveWelcomeAgentId({ sessionKey: "agent:cole:main" })).toBe("cole");
    expect(
      resolveWelcomeAgentId({ sessionKey: "main", sessionHost: { assistantAgentId: "sage" } }),
    ).toBe("sage");
  });

  it("shows a Bench agent's portrait in its halo when the gateway has no avatar", () => {
    const container = mountWelcome("agent:cole:main");
    const portrait = container.querySelector<HTMLImageElement>(".agent-chat__welcome-portrait");
    expect(portrait?.getAttribute("src")).toContain("agent-art/zig.png");
    expect(portrait?.classList.contains("bench-agent-halo")).toBe(true);
    expect(container.querySelector("openclaw-mascot")).toBeNull();
  });

  it("keeps Aurelius on the mascot and ignores a text avatar for Bench agents", () => {
    const container = mountWelcome("agent:aurelius:main", "A");
    expect(container.querySelector("openclaw-mascot")).not.toBeNull();
    expect(container.querySelector(".agent-chat__welcome-clawd--mascot")).not.toBeNull();
    expect(container.querySelector(".agent-chat__avatar--text")).toBeNull();
  });

  it("asks the Bench question and names the agent in the sub line", () => {
    const aurelius = mountWelcome("agent:aurelius:main");
    expect(aurelius.querySelector(".agent-chat__welcome h2")?.textContent).toBe(
      "What are we working on?",
    );
    expect(aurelius.querySelector(".agent-chat__hint")?.textContent?.trim()).toContain(
      "Aurelius runs your operations.",
    );
    const suggestions = [...aurelius.querySelectorAll(".agent-chat__suggestion")].map((button) =>
      button.textContent?.trim(),
    );
    expect(suggestions).toEqual([
      "Give me today's operating brief",
      "What did Zig move in the pipeline this week?",
      "Draft Monday's field briefing for Ember to send",
      "Check system health",
    ]);
    const cole = mountWelcome("agent:cole:main");
    expect(cole.querySelector(".agent-chat__hint")?.textContent?.trim()).toBe(
      "Agent handles sales. Ask for what you need.",
    );
  });

  it("leaves customer agents on the upstream fallbacks", () => {
    const main = mountWelcome("agent:main:main");
    expect(main.querySelector("openclaw-mascot")).not.toBeNull();
    expect(main.querySelector(".agent-chat__welcome h2")?.textContent).toBe("Agent");
    expect(main.querySelectorAll(".agent-chat__suggestion")[0]?.textContent?.trim()).toBe(
      "What can you do?",
    );
    expect(
      mountWelcome("agent:main:main", "M").querySelector(".agent-chat__avatar--text")?.textContent,
    ).toContain("M");
  });
});
