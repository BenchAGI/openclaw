import { describe, expect, it } from "vitest";
import { benchFabricEnabled } from "./bench-shell.ts";

describe("Bench gravity fabric gate", () => {
  it("keeps the no-op scaffold out of product surfaces", () => {
    expect(benchFabricEnabled("bench", true)).toBe(false);
    expect(benchFabricEnabled("bench-aurelius", undefined)).toBe(false);
    expect(benchFabricEnabled("claw", true)).toBe(false);
  });
});
