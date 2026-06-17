import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  RECOMMENDED_MODEL_BY_PROVIDER,
  resolveRecommendedModelForProvider,
} from "./defaults.js";

describe("resolveRecommendedModelForProvider", () => {
  it("returns the global baseline model for the default provider", () => {
    expect(resolveRecommendedModelForProvider(DEFAULT_PROVIDER)).toBe(DEFAULT_MODEL);
  });

  it("returns a concrete model for anthropic (the local-model customer case)", () => {
    expect(resolveRecommendedModelForProvider("anthropic")).toBe("claude-sonnet-4-6");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(resolveRecommendedModelForProvider("  Anthropic ")).toBe("claude-sonnet-4-6");
  });

  it("returns undefined for an unknown provider (caller then leaves the default unset)", () => {
    expect(resolveRecommendedModelForProvider("some-byo-provider")).toBeUndefined();
  });

  it("keys the registry by normalized lower-case provider ids", () => {
    for (const key of Object.keys(RECOMMENDED_MODEL_BY_PROVIDER)) {
      expect(key).toBe(key.toLowerCase());
    }
  });
});
