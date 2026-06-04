import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { resolveApiKey } from "./auth.js";

const SECRET = "bench_jBA5cCK6fyMCzIk3SoWF_supersecretvalue";

function configWith(benchCloud: Record<string, unknown>): OpenClawConfig {
  return { gateway: { benchCloud } } as unknown as OpenClawConfig;
}

describe("resolveApiKey", () => {
  it("returns unset when apiKeyRef is not configured", async () => {
    const result = await resolveApiKey({ config: configWith({ enabled: true }), env: {} });
    expect(result).toEqual({ status: "unset" });
  });

  it("resolves an env SecretRef to the key value", async () => {
    const result = await resolveApiKey({
      config: configWith({
        enabled: true,
        apiKeyRef: { source: "env", provider: "default", id: "BENCH_INSTANCE_API_KEY" },
      }),
      env: { BENCH_INSTANCE_API_KEY: SECRET },
    });
    expect(result).toEqual({ status: "ok", apiKey: SECRET });
  });

  it("resolves an inline env-template SecretRef string", async () => {
    const result = await resolveApiKey({
      config: configWith({
        enabled: true,
        apiKeyRef: "${BENCH_INSTANCE_API_KEY}",
      }),
      env: { BENCH_INSTANCE_API_KEY: SECRET },
    });
    expect(result).toEqual({ status: "ok", apiKey: SECRET });
  });

  it("returns an error (not the key) when the env var is missing", async () => {
    const result = await resolveApiKey({
      config: configWith({
        enabled: true,
        apiKeyRef: { source: "env", provider: "default", id: "BENCH_INSTANCE_API_KEY" },
      }),
      env: {},
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).not.toContain(SECRET);
      // Surfaces the ref label / path, not the value.
      expect(result.reason).toMatch(/apiKeyRef|SecretRef/i);
    }
  });

  it("never includes the secret value in the error reason on resolution failure", async () => {
    // exec source pointing at a non-configured provider — fails to resolve.
    const result = await resolveApiKey({
      config: configWith({
        enabled: true,
        apiKeyRef: { source: "exec", provider: "missing-vault", id: "bench/api-key" },
      }),
      env: { BENCH_INSTANCE_API_KEY: SECRET },
    });
    expect(result.status).toBe("error");
    if (result.status === "error") {
      expect(result.reason).not.toContain(SECRET);
    }
  });
});
