/** Ephemeral MCP response metadata, deliberately outside serialized tool results. */
export type McpResultHookMetadata = Readonly<{
  serverName: string;
  toolName: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

const results = new WeakMap<object, McpResultHookMetadata>();

function snapshotMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  let nodes = 0;
  function copy(input: unknown, depth: number): unknown {
    if (++nodes > 512 || depth > 8) throw new Error("metadata bound");
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string" && input.length <= 4096) return input;
    if (typeof input === "number" && Number.isFinite(input)) return input;
    if (!input || typeof input !== "object") throw new Error("metadata type");
    if (Array.isArray(input)) {
      if (input.length > 128) throw new Error("metadata bound");
      return Object.freeze(input.map((item) => copy(item, depth + 1)));
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("metadata type");
    const output: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(input))) {
      if (
        !descriptor.enumerable ||
        !("value" in descriptor) ||
        key.length > 128 ||
        key === "__proto__"
      ) {
        throw new Error("metadata type");
      }
      output[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  }
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const snapshot = copy(value, 0) as Readonly<Record<string, unknown>>;
    return Buffer.byteLength(JSON.stringify(snapshot)) <= 16_384 ? snapshot : undefined;
  } catch {
    // Untrusted MCP metadata must never break an otherwise usable tool call.
    return undefined;
  }
}

export function rememberMcpResultHookMetadata(
  result: object,
  source: { serverName: string; toolName: string; metadata: unknown },
): void {
  const metadata = snapshotMetadata(source.metadata);
  if (metadata) {
    results.set(
      result,
      Object.freeze({ serverName: source.serverName, toolName: source.toolName, metadata }),
    );
  }
}

/** Consume only the exact native result. Replaced/cloned/synthetic results do
 * not inherit provenance. Never reconstruct metadata from details or content. */
export function takeMcpResultHookMetadata(result: unknown): McpResultHookMetadata | undefined {
  if (!result || typeof result !== "object") return undefined;
  const metadata = results.get(result);
  results.delete(result);
  return metadata;
}
