// BenchSyncClient — origin-pinned HTTP transport for the Bench cloud sync API.
//
// This mirrors the protection style of src/gateway/bench-cloud-client.ts:
// every request URL is resolved against the configured apiBaseUrl and rejected
// if its origin differs. Those helpers are module-private in core, so we
// replicate them minimally here to keep this an additive fork extension that
// does not edit core (cheap upstream merges).

/** Resolved transport config for the Bench cloud sync API. */
export type BenchSyncClientConfig = {
  /** Base URL for the Bench cloud API, e.g. https://benchagi.com. */
  apiBaseUrl: string;
  /** Bench instance id; all sync routes are scoped to this id. */
  instanceId: string;
  /** Instance API key sent as the X-API-Key header. Never logged. */
  apiKey: string;
  /** Per-request timeout in milliseconds. Default: 30000. */
  timeoutMs?: number;
  /** Max response body size in bytes before the body is rejected. Default: 8MB. */
  maxResponseBytes?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** Typed error for Bench cloud sync failures, modeled on BenchCloudBridgeError. */
export class BenchSyncClientError extends Error {
  readonly status?: number;
  readonly code?: string;

  constructor(message: string, opts?: { status?: number; code?: string }) {
    super(message);
    this.name = "BenchSyncClientError";
    this.status = opts?.status;
    this.code = opts?.code;
  }
}

/** Directive types this gateway knows how to pull/apply. */
export type BenchSyncDirectiveType = "skill_proposal_decision" | "workboard_create_card";

export type BenchSyncDirectiveAck = {
  status: "applied" | "failed" | "skipped";
  reason?: string;
};

export type BenchSyncPullDirectivesQuery = {
  types: BenchSyncDirectiveType[];
  cursor?: string | null;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Resolve a path (or absolute URL) against apiBaseUrl and reject anything whose
 * origin differs. This is the origin-pin guard — it blocks open redirects and
 * server-supplied URLs that try to leave the configured tenant origin.
 */
export function resolveBenchSyncUrl(apiBaseUrl: string, pathOrUrl: string): string {
  const baseUrl = new URL(`${trimTrailingSlash(apiBaseUrl)}/`);
  const resolved = new URL(pathOrUrl, baseUrl);
  if (resolved.origin !== baseUrl.origin) {
    throw new BenchSyncClientError("Bench sync URL must stay on the configured API origin", {
      code: "url_origin",
    });
  }
  return resolved.toString();
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const lengthHeader = response.headers.get("content-length");
  if (lengthHeader) {
    const declared = Number(lengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new BenchSyncClientError("Bench sync response body exceeds the allowed size", {
        status: response.status,
        code: "response_too_large",
      });
    }
  }
  const text = await response.text();
  // Byte length, not code-unit length, to honor the configured cap.
  if (Buffer.byteLength(text, "utf8") > maxBytes) {
    throw new BenchSyncClientError("Bench sync response body exceeds the allowed size", {
      status: response.status,
      code: "response_too_large",
    });
  }
  return text;
}

async function parseJsonResponse(response: Response, maxBytes: number): Promise<unknown> {
  const text = await readBoundedText(response, maxBytes);
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new BenchSyncClientError("Bench sync returned invalid JSON", {
      status: response.status,
    });
  }
}

function errorMessageFromBody(body: unknown, fallback: string): { message: string; code?: string } {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const message = typeof record.error === "string" ? record.error : fallback;
    const code = typeof record.code === "string" ? record.code : undefined;
    return { message, code };
  }
  return { message: fallback };
}

export type BenchSyncRequestOptions = {
  signal?: AbortSignal;
};

/**
 * Origin-pinned, auth-bearing client for the Bench cloud sync API. All routes
 * are scoped to a single instance id; the tenant is never derived from the
 * request body.
 */
export class BenchSyncClient {
  private readonly apiBaseUrl: string;
  private readonly instanceId: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: BenchSyncClientConfig, deps?: { fetchFn?: typeof fetch }) {
    if (!config.apiBaseUrl || !config.apiBaseUrl.trim()) {
      throw new BenchSyncClientError("BenchSyncClient requires apiBaseUrl", { code: "config" });
    }
    if (!config.instanceId || !config.instanceId.trim()) {
      throw new BenchSyncClientError("BenchSyncClient requires instanceId", { code: "config" });
    }
    if (!config.apiKey || !config.apiKey.trim()) {
      throw new BenchSyncClientError("BenchSyncClient requires apiKey", { code: "config" });
    }
    this.apiBaseUrl = config.apiBaseUrl;
    this.instanceId = config.instanceId;
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetchFn = deps?.fetchFn ?? fetch;
  }

  /** Base path for instance-scoped sync routes. */
  private instancePath(suffix: string): string {
    return `/api/v1/instances/${encodePathSegment(this.instanceId)}${suffix}`;
  }

  private resolve(pathOrUrl: string): string {
    return resolveBenchSyncUrl(this.apiBaseUrl, pathOrUrl);
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      ...extra,
    };
  }

  private async request(params: {
    method: "GET" | "POST";
    pathOrUrl: string;
    body?: unknown;
    signal?: AbortSignal;
  }): Promise<unknown> {
    const url = this.resolve(params.pathOrUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (params.signal) {
      if (params.signal.aborted) {
        controller.abort();
      } else {
        params.signal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    let response: Response;
    try {
      response = await this.fetchFn(url, {
        method: params.method,
        // Reject redirects rather than silently following them off-origin.
        redirect: "manual",
        headers: this.buildHeaders(
          params.body === undefined ? undefined : { "content-type": "application/json" },
        ),
        body: params.body === undefined ? undefined : JSON.stringify(params.body),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BenchSyncClientError("Bench sync request timed out or was aborted", {
          code: "aborted",
        });
      }
      throw new BenchSyncClientError(
        err instanceof Error ? err.message : "Bench sync request failed",
        { code: "network" },
      );
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onExternalAbort);
    }

    // A redirect under redirect:"manual" surfaces as an opaqueredirect/3xx — any
    // attempt to bounce us to another origin is rejected here.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("location");
      if (location) {
        // Throws if the redirect target leaves the configured origin.
        this.resolve(location);
      }
      throw new BenchSyncClientError("Bench sync refused an unexpected redirect response", {
        status: response.status,
        code: "redirect",
      });
    }

    const parsed = await parseJsonResponse(response, this.maxResponseBytes);
    if (!response.ok) {
      const error = errorMessageFromBody(parsed, `Bench sync returned HTTP ${response.status}`);
      throw new BenchSyncClientError(error.message, {
        status: response.status,
        code: error.code,
      });
    }
    return parsed;
  }

  /** UP: mirror a batch of Workboard card snapshots. */
  async postAgentTaskCards(batch: unknown, options?: BenchSyncRequestOptions): Promise<unknown> {
    return this.request({
      method: "POST",
      pathOrUrl: this.instancePath("/agent-tasks/sync"),
      body: batch,
      signal: options?.signal,
    });
  }

  /** UP: mirror a batch of skill proposals. */
  async postSkillProposals(batch: unknown, options?: BenchSyncRequestOptions): Promise<unknown> {
    return this.request({
      method: "POST",
      pathOrUrl: this.instancePath("/skill-proposals/sync"),
      body: batch,
      signal: options?.signal,
    });
  }

  /** DOWN: pull typed directives. */
  async pullDirectives(
    query: BenchSyncPullDirectivesQuery,
    options?: BenchSyncRequestOptions,
  ): Promise<unknown> {
    const search = new URLSearchParams();
    if (query.types.length > 0) {
      search.set("types", query.types.join(","));
    }
    if (query.cursor) {
      search.set("cursor", query.cursor);
    }
    const qs = search.toString();
    return this.request({
      method: "GET",
      pathOrUrl: this.instancePath(`/sync/directives${qs ? `?${qs}` : ""}`),
      signal: options?.signal,
    });
  }

  /** DOWN: ack a directive with the apply outcome. */
  async ackDirective(
    id: string,
    ack: BenchSyncDirectiveAck,
    options?: BenchSyncRequestOptions,
  ): Promise<unknown> {
    if (!id || !id.trim()) {
      throw new BenchSyncClientError("ackDirective requires a directive id", { code: "config" });
    }
    return this.request({
      method: "POST",
      pathOrUrl: this.instancePath(`/sync/directives/${encodePathSegment(id)}/ack`),
      body: ack,
      signal: options?.signal,
    });
  }
}
