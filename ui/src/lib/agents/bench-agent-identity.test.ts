// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BENCH_RARITY_COLORS,
  benchAgentDisplayName,
  benchAgentIdentity,
  benchAgentRarityColor,
  benchAgentStyle,
  benchAgentTextAccent,
} from "./bench-agent-identity.ts";

describe("bench agent identity manifest", () => {
  it("resolves the fleet by id and by persona alias, case-insensitively", () => {
    expect(benchAgentIdentity("aurelius")?.rarity).toBe("legendary");
    expect(benchAgentIdentity("Cole")?.name).toBe("Zig");
    expect(benchAgentIdentity("zig")?.id).toBe("cole");
    expect(benchAgentIdentity("sully")?.name).toBe("Piper");
    expect(benchAgentIdentity("sentinel")?.portrait).toBeNull();
    expect(benchAgentIdentity("main")).toBeNull();
    expect(benchAgentIdentity(null)).toBeNull();
  });

  it("paints unknown agents with the theme accent and the common ring", () => {
    expect(benchAgentStyle("main")).toBe(
      `--agent-accent: var(--accent); --agent-rarity: ${BENCH_RARITY_COLORS.common};`,
    );
    expect(benchAgentStyle("aurelius")).toBe(
      `--agent-accent: #e7c182; --agent-rarity: ${BENCH_RARITY_COLORS.legendary};`,
    );
    expect(benchAgentRarityColor(null)).toBe("#c8ced6");
  });

  it("fills the display name only when the gateway label is the bare id", () => {
    expect(benchAgentDisplayName("aurelius", "aurelius")).toBe("Aurelius");
    expect(benchAgentDisplayName("cole", "")).toBe("Zig");
    expect(benchAgentDisplayName("cole", "Zig Ziglar")).toBe("Zig Ziglar");
    expect(benchAgentDisplayName("main", "main")).toBe("main");
  });

  it("drops Aurelius's gold to bronze only for text on light surfaces", () => {
    const aurelius = benchAgentIdentity("aurelius");
    expect(benchAgentTextAccent(aurelius, false)).toBe("#e7c182");
    expect(benchAgentTextAccent(aurelius, true)).toBe("#8a6a2c");
    expect(benchAgentTextAccent(benchAgentIdentity("ember"), true)).toBe("#f5879e");
    expect(benchAgentTextAccent(null, true)).toBeNull();
  });
});
