import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("OpenClawSchema gateway.benchCloud sync fields", () => {
  it("accepts apiKeyRef as a SecretRef", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          enabled: true,
          apiKeyRef: { source: "env", provider: "default", id: "BENCH_INSTANCE_API_KEY" },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts apiKeyRef as an inline env template string", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          apiKeyRef: "${BENCH_INSTANCE_API_KEY}",
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts workboardSync with enabled + pollIntervalMs", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          enabled: true,
          workboardSync: { enabled: true, pollIntervalMs: 15000 },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("accepts skillSync with enabled + mirrorPendingUp", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          enabled: true,
          skillSync: { enabled: true, mirrorPendingUp: true },
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-integer workboardSync.pollIntervalMs", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          workboardSync: { pollIntervalMs: 1.5 },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-positive workboardSync.pollIntervalMs", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          workboardSync: { pollIntervalMs: 0 },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-boolean skillSync.mirrorPendingUp", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          skillSync: { mirrorPendingUp: "yes" },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside workboardSync (strict object)", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          workboardSync: { enabled: true, bogus: true },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it("rejects unknown keys inside skillSync (strict object)", () => {
    const result = OpenClawSchema.safeParse({
      gateway: {
        benchCloud: {
          skillSync: { enabled: true, bogus: 1 },
        },
      },
    });
    expect(result.success).toBe(false);
  });
});
