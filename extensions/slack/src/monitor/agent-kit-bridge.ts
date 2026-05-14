import type { SlackAgentKitBridgeConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";

export type BridgeSurfaceContext = {
  account_id: string;
  team_id: string;
  app_id: string;
  channel_id?: string;
  thread_ts?: string;
  user_id: string;
  surface_type: string;
  turn_source_event: string;
  turn_source_ts?: string;
};

export type BridgeToolIntent = Record<string, unknown>;

export type BridgeRunRequest = {
  session_key: string;
  user_text: string;
  surface_context: BridgeSurfaceContext;
  resume_session_id?: string;
};

export type BridgeRunResponse = {
  response_text: string;
  session_id?: string;
  tool_intents: BridgeToolIntent[];
  error?: string;
};

export type BridgeErrorCode =
  | "disabled"
  | "config_error"
  | "transport_error"
  | "timeout"
  | "runtime_error"
  | "validation_error";

export type BridgeError = {
  code: BridgeErrorCode;
  message: string;
  disabled?: true;
  status?: number;
  retryable: boolean;
  latency_ms: number;
};

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type BridgeHealthOk = {
  ok: true;
  version?: string;
  latency_ms: number;
};

export type BridgeHealthResult =
  | BridgeHealthOk
  | { disabled: true; latency_ms: number }
  | { ok: false; error: BridgeError };

export type AgentKitBridgeClient = {
  healthz: () => Promise<BridgeHealthResult>;
  run: (req: BridgeRunRequest) => Promise<Result<BridgeRunResponse, BridgeError>>;
};

export type AgentKitBridgeLogger = {
  debug?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

export type AgentKitBridgeClientOptions = {
  fetchFn?: typeof fetch;
  logger?: AgentKitBridgeLogger;
  accountId?: string;
  teamId?: string;
  appId?: string;
};

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_BRIDGE_URL = "http://127.0.0.1:8717";

function nowMs(): number {
  return Date.now();
}

function resolveTimeoutMs(config: SlackAgentKitBridgeConfig): number {
  return config.timeoutMs && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function createBridgeError(params: {
  code: BridgeErrorCode;
  message: string;
  latencyMs: number;
  retryable: boolean;
  status?: number;
  disabled?: true;
}): BridgeError {
  return {
    code: params.code,
    message: params.message,
    retryable: params.retryable,
    latency_ms: params.latencyMs,
    ...(params.status === undefined ? {} : { status: params.status }),
    ...(params.disabled ? { disabled: true } : {}),
  };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function resolveBaseUrl(config: SlackAgentKitBridgeConfig): URL | BridgeError {
  const raw = config.url?.trim() || DEFAULT_BRIDGE_URL;
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return createBridgeError({
        code: "config_error",
        message: "Slack Agent Kit bridge url must use http or https.",
        latencyMs: 0,
        retryable: false,
      });
    }
    return url;
  } catch {
    return createBridgeError({
      code: "config_error",
      message: "Slack Agent Kit bridge url is invalid.",
      latencyMs: 0,
      retryable: false,
    });
  }
}

function bridgeUrl(baseUrl: URL, path: "/healthz" | "/run"): URL {
  const url = new URL(baseUrl.href);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}${path}`;
  url.search = "";
  url.hash = "";
  return url;
}

async function fetchWithTimeout(params: {
  fetchFn: typeof fetch;
  url: URL;
  init: RequestInit;
  timeoutMs: number;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    return await params.fetchFn(params.url, {
      ...params.init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function validateHealthResponse(value: unknown): { ok: true; version?: string } | string {
  if (!isRecord(value)) {
    return "Slack Agent Kit bridge health response must be an object.";
  }
  if (value.ok !== undefined && value.ok !== true) {
    return "Slack Agent Kit bridge health response reported not ok.";
  }
  if (value.ok === undefined && value.ready !== undefined && value.ready !== true) {
    return "Slack Agent Kit bridge health response reported not ready.";
  }
  return { ok: true, version: optionalString(value.version) };
}

function validateRunResponse(value: unknown): BridgeRunResponse | string {
  if (!isRecord(value)) {
    return "Slack Agent Kit bridge run response must be an object.";
  }
  const error = optionalString(value.error);
  const responseText = optionalString(value.response_text);
  const sessionId = optionalString(value.session_id);
  const toolIntents = value.tool_intents;
  if (error !== undefined) {
    return {
      response_text: responseText ?? "",
      session_id: sessionId,
      tool_intents: Array.isArray(toolIntents)
        ? toolIntents.filter(isRecord).map((intent) => ({ ...intent }))
        : [],
      error,
    };
  }
  if (responseText === undefined) {
    return "Slack Agent Kit bridge run response is missing response_text.";
  }
  if (!Array.isArray(toolIntents)) {
    return "Slack Agent Kit bridge run response is missing tool_intents.";
  }
  if (!toolIntents.every(isRecord)) {
    return "Slack Agent Kit bridge run response tool_intents must be objects.";
  }
  return {
    response_text: responseText,
    session_id: sessionId,
    tool_intents: toolIntents.map((intent) => ({ ...intent })),
  };
}

async function parseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function buildLogMeta(params: {
  event: "agent_kit_bridge.healthz" | "agent_kit_bridge.run";
  accountId?: string;
  teamId?: string;
  appId?: string;
  surface?: BridgeSurfaceContext;
  latencyMs: number;
  status: "ok" | "disabled" | "error";
  code?: BridgeErrorCode;
}): Record<string, unknown> {
  return {
    event: params.event,
    account_id: params.surface?.account_id ?? params.accountId,
    team_id: params.surface?.team_id ?? params.teamId,
    app_id: params.surface?.app_id ?? params.appId,
    channel_id: params.surface?.channel_id,
    thread_ts: params.surface?.thread_ts,
    user_id: params.surface?.user_id,
    surface_type: params.surface?.surface_type,
    ts: params.surface?.turn_source_ts,
    latency_ms: params.latencyMs,
    status: params.status,
    code: params.code,
  };
}

function logBridgeCall(logger: AgentKitBridgeLogger | undefined, meta: Record<string, unknown>) {
  const status = meta.status;
  if (status === "ok" || status === "disabled") {
    logger?.info?.(meta);
    return;
  }
  logger?.warn?.(meta);
}

function disabledError(latencyMs: number): BridgeError {
  return createBridgeError({
    code: "disabled",
    message: "Slack Agent Kit bridge is disabled.",
    latencyMs,
    retryable: false,
    disabled: true,
  });
}

function resolveFetchFn(fetchFn?: typeof fetch): typeof fetch | undefined {
  return resolveFetch(
    fetchFn ?? (fetchWithRuntimeDispatcherOrMockedGlobal as unknown as typeof fetch),
  );
}

export function createAgentKitBridgeClient(
  config: SlackAgentKitBridgeConfig,
  options: AgentKitBridgeClientOptions = {},
): AgentKitBridgeClient {
  const fetchFn = resolveFetchFn(options.fetchFn);

  const healthz = async (): Promise<BridgeHealthResult> => {
    const start = nowMs();
    if (!config.enabled) {
      const latencyMs = nowMs() - start;
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.healthz",
          accountId: options.accountId,
          teamId: options.teamId,
          appId: options.appId,
          latencyMs,
          status: "disabled",
          code: "disabled",
        }),
      );
      return { disabled: true, latency_ms: latencyMs };
    }
    if (!fetchFn) {
      const latencyMs = nowMs() - start;
      const error = createBridgeError({
        code: "transport_error",
        message: "No fetch implementation is available for Slack Agent Kit bridge.",
        latencyMs,
        retryable: true,
      });
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.healthz",
          accountId: options.accountId,
          teamId: options.teamId,
          appId: options.appId,
          latencyMs,
          status: "error",
          code: error.code,
        }),
      );
      return { ok: false, error };
    }

    const baseUrl = resolveBaseUrl(config);
    if (!(baseUrl instanceof URL)) {
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.healthz",
          accountId: options.accountId,
          teamId: options.teamId,
          appId: options.appId,
          latencyMs: baseUrl.latency_ms,
          status: "error",
          code: baseUrl.code,
        }),
      );
      return { ok: false, error: baseUrl };
    }

    try {
      const response = await fetchWithTimeout({
        fetchFn,
        url: bridgeUrl(baseUrl, "/healthz"),
        init: { method: "GET" },
        timeoutMs: resolveTimeoutMs(config),
      });
      const latencyMs = nowMs() - start;
      if (!response.ok) {
        const error = createBridgeError({
          code: "transport_error",
          message: `Slack Agent Kit bridge health request failed with HTTP ${response.status}.`,
          latencyMs,
          retryable: response.status >= 500,
          status: response.status,
        });
        logBridgeCall(
          options.logger,
          buildLogMeta({
            event: "agent_kit_bridge.healthz",
            accountId: options.accountId,
            teamId: options.teamId,
            appId: options.appId,
            latencyMs,
            status: "error",
            code: error.code,
          }),
        );
        return { ok: false, error };
      }
      const parsed = validateHealthResponse(await parseJson(response));
      if (typeof parsed === "string") {
        const error = createBridgeError({
          code: "validation_error",
          message: parsed,
          latencyMs,
          retryable: false,
          status: response.status,
        });
        logBridgeCall(
          options.logger,
          buildLogMeta({
            event: "agent_kit_bridge.healthz",
            accountId: options.accountId,
            teamId: options.teamId,
            appId: options.appId,
            latencyMs,
            status: "error",
            code: error.code,
          }),
        );
        return { ok: false, error };
      }
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.healthz",
          accountId: options.accountId,
          teamId: options.teamId,
          appId: options.appId,
          latencyMs,
          status: "ok",
        }),
      );
      return { ...parsed, latency_ms: latencyMs };
    } catch (error) {
      const latencyMs = nowMs() - start;
      const bridgeError = createBridgeError({
        code: isAbortError(error) ? "timeout" : "transport_error",
        message: formatErrorMessage(error),
        latencyMs,
        retryable: true,
      });
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.healthz",
          accountId: options.accountId,
          teamId: options.teamId,
          appId: options.appId,
          latencyMs,
          status: "error",
          code: bridgeError.code,
        }),
      );
      return { ok: false, error: bridgeError };
    }
  };

  const run = async (req: BridgeRunRequest): Promise<Result<BridgeRunResponse, BridgeError>> => {
    const start = nowMs();
    if (!config.enabled) {
      const error = disabledError(nowMs() - start);
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.run",
          surface: req.surface_context,
          latencyMs: error.latency_ms,
          status: "disabled",
          code: error.code,
        }),
      );
      return { ok: false, error };
    }
    if (!fetchFn) {
      const error = createBridgeError({
        code: "transport_error",
        message: "No fetch implementation is available for Slack Agent Kit bridge.",
        latencyMs: nowMs() - start,
        retryable: true,
      });
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.run",
          surface: req.surface_context,
          latencyMs: error.latency_ms,
          status: "error",
          code: error.code,
        }),
      );
      return { ok: false, error };
    }

    const baseUrl = resolveBaseUrl(config);
    if (!(baseUrl instanceof URL)) {
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.run",
          surface: req.surface_context,
          latencyMs: baseUrl.latency_ms,
          status: "error",
          code: baseUrl.code,
        }),
      );
      return { ok: false, error: baseUrl };
    }

    try {
      const response = await fetchWithTimeout({
        fetchFn,
        url: bridgeUrl(baseUrl, "/run"),
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(req),
        },
        timeoutMs: resolveTimeoutMs(config),
      });
      const latencyMs = nowMs() - start;
      if (!response.ok) {
        const error = createBridgeError({
          code: "transport_error",
          message: `Slack Agent Kit bridge run request failed with HTTP ${response.status}.`,
          latencyMs,
          retryable: response.status >= 500,
          status: response.status,
        });
        logBridgeCall(
          options.logger,
          buildLogMeta({
            event: "agent_kit_bridge.run",
            surface: req.surface_context,
            latencyMs,
            status: "error",
            code: error.code,
          }),
        );
        return { ok: false, error };
      }
      const parsed = validateRunResponse(await parseJson(response));
      if (typeof parsed === "string") {
        const error = createBridgeError({
          code: "validation_error",
          message: parsed,
          latencyMs,
          retryable: false,
          status: response.status,
        });
        logBridgeCall(
          options.logger,
          buildLogMeta({
            event: "agent_kit_bridge.run",
            surface: req.surface_context,
            latencyMs,
            status: "error",
            code: error.code,
          }),
        );
        return { ok: false, error };
      }
      if (parsed.error) {
        const error = createBridgeError({
          code: "runtime_error",
          message: parsed.error,
          latencyMs,
          retryable: false,
          status: response.status,
        });
        logBridgeCall(
          options.logger,
          buildLogMeta({
            event: "agent_kit_bridge.run",
            surface: req.surface_context,
            latencyMs,
            status: "error",
            code: error.code,
          }),
        );
        return { ok: false, error };
      }
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.run",
          surface: req.surface_context,
          latencyMs,
          status: "ok",
        }),
      );
      // OpenClaw's session-store layer owns retention for this opaque session_id.
      return { ok: true, value: parsed };
    } catch (error) {
      const latencyMs = nowMs() - start;
      const bridgeError = createBridgeError({
        code: isAbortError(error) ? "timeout" : "transport_error",
        message: formatErrorMessage(error),
        latencyMs,
        retryable: true,
      });
      logBridgeCall(
        options.logger,
        buildLogMeta({
          event: "agent_kit_bridge.run",
          surface: req.surface_context,
          latencyMs,
          status: "error",
          code: bridgeError.code,
        }),
      );
      return { ok: false, error: bridgeError };
    }
  };

  return { healthz, run };
}
