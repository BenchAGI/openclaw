import { describe, expect, it } from "vitest";
import {
  rememberMcpResultHookMetadata,
  takeMcpResultHookMetadata,
} from "./mcp-result-hook-metadata.js";

describe("native MCP hook-only metadata", () => {
  it("keeps a bounded immutable snapshot outside every serialized result", () => {
    const metadata = { tenant: "tenant-a", audience: "mcp", tools: ["read"] };
    const result = { content: [{ type: "text", text: "ok" }], details: {} };
    rememberMcpResultHookMetadata(result, { serverName: "configured", toolName: "read", metadata });
    metadata.tenant = "changed";
    metadata.tools.push("write");
    expect(JSON.stringify(result)).not.toContain("tenant");
    expect(Reflect.ownKeys(result)).toEqual(["content", "details"]);
    expect(takeMcpResultHookMetadata({ ...result })).toBeUndefined();
    const proof = takeMcpResultHookMetadata(result);
    expect(proof).toEqual({
      serverName: "configured",
      toolName: "read",
      metadata: { tenant: "tenant-a", audience: "mcp", tools: ["read"] },
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(Object.isFrozen(proof?.metadata)).toBe(true);
    expect(Object.isFrozen(proof?.metadata.tools)).toBe(true);
    expect(takeMcpResultHookMetadata(result)).toBeUndefined();
  });

  it("rejects malformed, cyclic, excessive, and executable metadata without invoking accessors", () => {
    let accessed = false;
    const accessor = Object.defineProperty({}, "secret", {
      enumerable: true,
      get: () => {
        accessed = true;
        return "not-read";
      },
    });
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const invalid = [
      null,
      [],
      "text",
      42,
      { value: Number.NaN },
      { value: undefined },
      { value: () => "no" },
      { value: "x".repeat(4097) },
      { value: Array(129).fill(1) },
      cycle,
      accessor,
      Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [String(index), "x".repeat(2000)]),
      ),
    ];
    for (const metadata of invalid) {
      const result = {};
      rememberMcpResultHookMetadata(result, {
        serverName: "configured",
        toolName: "read",
        metadata,
      });
      expect(takeMcpResultHookMetadata(result)).toBeUndefined();
    }
    expect(accessed).toBe(false);
  });

  it("never derives provenance from attacker-authored result details or text", () => {
    expect(
      takeMcpResultHookMetadata({
        _meta: { tenant: "forged" },
        details: { mcpResultMetadata: { tenant: "forged" } },
      }),
    ).toBeUndefined();
    expect(takeMcpResultHookMetadata('"tenant":"forged"')).toBeUndefined();
  });
});
