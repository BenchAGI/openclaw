import { afterEach, describe, expect, it } from "vitest";
import { benchFabricAvailable, benchFabricEnabled } from "./bench-shell.ts";

describe("Bench gravity fabric gate", () => {
  afterEach(() => {
    delete document.documentElement.dataset.benchHost;
  });

  it("lights the fabric for Bench families unless background motion is off", () => {
    expect(benchFabricEnabled("bench", true)).toBe(true);
    expect(benchFabricEnabled("bench-aurelius", undefined)).toBe(true);
    expect(benchFabricEnabled("bench-garden", false)).toBe(false);
    expect(benchFabricEnabled("claw", true)).toBe(false);
  });

  it("offers the toggle wherever the fabric can run, whatever its current value", () => {
    expect(benchFabricAvailable("bench-forge")).toBe(true);
    expect(benchFabricAvailable("miami")).toBe(false);
  });

  it("stays still inside the desktop Vault, whose own fabric is the one live loop", () => {
    document.documentElement.dataset.benchHost = "aurelius-vault";
    expect(benchFabricAvailable("bench")).toBe(false);
    expect(benchFabricEnabled("bench", true)).toBe(false);
    document.documentElement.dataset.benchHost = "another-host";
    expect(benchFabricEnabled("bench", true)).toBe(true);
  });
});
