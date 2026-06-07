import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearMemoryPluginState, registerMemoryPromptSection } from "../plugins/memory-state.js";
import { buildAgentSystemPrompt } from "./system-prompt.js";

describe("buildAgentSystemPrompt memory guidance", () => {
  afterEach(() => {
    clearMemoryPluginState();
  });

  it("can suppress base memory guidance so context engines own memory prompt assembly", () => {
    registerMemoryPromptSection(() => ["## Memory Recall", "Use memory carefully.", ""]);

    const promptWithMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
    });
    const promptWithoutMemory = buildAgentSystemPrompt({
      workspaceDir: "/tmp/openclaw",
      includeMemorySection: false,
    });

    expect(promptWithMemory).toContain("## Memory Recall");
    expect(promptWithoutMemory).not.toContain("## Memory Recall");
  });
});

describe("buildAgentSystemPrompt canonical (Tier-0) memory", () => {
  it("injects a per-agent canonical memory section, scoped to that agent", () => {
    const ws = mkdtempSync(join(tmpdir(), "oc-canon-"));
    try {
      mkdirSync(join(ws, "memory"), { recursive: true });
      writeFileSync(join(ws, "memory", "CORE.md"), "# CORE\nThe operator is Light.");
      const aurelius = buildAgentSystemPrompt({ workspaceDir: ws, agentId: "aurelius" });
      expect(aurelius).toContain("## Canonical Memory");
      expect(aurelius).toContain("The operator is Light.");
      // Strictly per-agent: a different agent must NOT inherit Aurelius's memory.
      const cole = buildAgentSystemPrompt({ workspaceDir: ws, agentId: "cole" });
      expect(cole).not.toContain("The operator is Light.");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("fails open when the agent has no canonical home (no section, never throws)", () => {
    const ws = mkdtempSync(join(tmpdir(), "oc-canon-"));
    try {
      const prompt = buildAgentSystemPrompt({ workspaceDir: ws, agentId: "aurelius" });
      expect(prompt).not.toContain("## Canonical Memory");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
