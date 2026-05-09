import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  registerAgentEventListener,
  type AgentEventPayload,
  type AgentEventStream,
} from "./agent-events.js";
import { formatErrorMessage } from "./errors.js";
import { resolveHomeRelativePath } from "./home-dir.js";

const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
const DEFAULT_MAX_BATCH_SIZE = 64;
const DEFAULT_MAX_QUEUE_SIZE = DEFAULT_MAX_BATCH_SIZE * 32;
const DROP_WARNING_INTERVAL_MS = 10_000;
const OBSERVABILITY_CONFIG_RELATIVE_PATH = path.join("config", "observability.json");
const EXPLICIT_AGENT_EVENT_TYPES = new Set([
  "agent.session.opened",
  "agent.session.closed",
  "agent.human_queue_item",
]);
const FORWARDABLE_AGENT_STREAMS = new Set<AgentEventStream>([
  "lifecycle",
  "tool",
  "assistant",
  "thinking",
  "plan",
  "approval",
  "error",
  "item",
  "command_output",
  "patch",
  "compaction",
]);

export type AgentEventsForwarderConfig = {
  enabled: boolean;
  endpoint: string;
  tenantApiKey: string;
  agentId: string;
  hostId: string;
  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
};

export type BenchAgentEvent = {
  type: string;
  runId: string;
  seq: number;
  ts: number;
  stream: string;
  data: Record<string, unknown>;
  agentId: string;
  hostId: string;
  sessionKey?: string;
  sessionId?: string;
  schemaVersion: 1;
};

export type AgentEventsBatchRequest = {
  endpoint: string;
  headers: Record<string, string>;
  body: {
    events: BenchAgentEvent[];
  };
};

export type AgentEventsForwarderDeps = {
  config?: AgentEventsForwarderConfig | null;
  loadConfig?: () => AgentEventsForwarderConfig | null | undefined;
  registerAgentEventListener?: (listener: (evt: AgentEventPayload) => void) => () => void;
  sendBatch?: (request: AgentEventsBatchRequest) => Promise<void>;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  onError?: (error: unknown) => void;
};

export type AgentEventsForwarder = {
  flush: () => Promise<void>;
  flushAndStop: () => Promise<void>;
  stop: () => void;
  getPendingCount: () => number;
};

type ActiveForwarderState = {
  forwarder: AgentEventsForwarder | null;
  startupAttempted: boolean;
};

const activeForwarderState: ActiveForwarderState = {
  forwarder: null,
  startupAttempted: false,
};

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readOptionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const next = Math.trunc(value);
  return next > 0 ? next : undefined;
}

function normalizeObservabilityConfig(raw: unknown): AgentEventsForwarderConfig | null {
  const record = readRecord(raw);
  if (!record) {
    return null;
  }
  if (record.enabled !== true) {
    return null;
  }

  const endpoint = normalizeOptionalString(record.endpoint);
  const tenantApiKey = normalizeOptionalString(record.tenantApiKey);
  const agentId = normalizeOptionalString(record.agentId);
  const hostId = normalizeOptionalString(record.hostId);
  if (!endpoint || !tenantApiKey || !agentId || !hostId) {
    return null;
  }

  return {
    enabled: true,
    endpoint,
    tenantApiKey,
    agentId,
    hostId,
    flushIntervalMs: readOptionalPositiveInt(record.flushIntervalMs),
    maxBatchSize: readOptionalPositiveInt(record.maxBatchSize),
    maxQueueSize: readOptionalPositiveInt(record.maxQueueSize),
  };
}

export function resolveAgentEventsForwarderConfigPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicit = normalizeOptionalString(env.OPENCLAW_OBSERVABILITY_CONFIG_PATH);
  if (explicit) {
    return resolveHomeRelativePath(explicit, { env });
  }
  return path.join(resolveStateDir(env), OBSERVABILITY_CONFIG_RELATIVE_PATH);
}

export function loadAgentEventsForwarderConfig(
  configPath = resolveAgentEventsForwarderConfigPath(),
): AgentEventsForwarderConfig | null {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch {
    return null;
  }

  try {
    return normalizeObservabilityConfig(JSON.parse(raw));
  } catch {
    return null;
  }
}

function resolveEventType(event: AgentEventPayload): string | null {
  const stream = normalizeOptionalString(event.stream);
  if (!stream) {
    return null;
  }
  if (EXPLICIT_AGENT_EVENT_TYPES.has(stream)) {
    return stream;
  }
  if (!FORWARDABLE_AGENT_STREAMS.has(stream)) {
    return null;
  }
  return `agent.stream.${stream}`;
}

function readEventStringData(event: AgentEventPayload, key: string): string | undefined {
  return normalizeOptionalString(event.data[key]);
}

export function buildBenchAgentEvent(
  event: AgentEventPayload,
  config: Pick<AgentEventsForwarderConfig, "agentId" | "hostId">,
): BenchAgentEvent | null {
  const type = resolveEventType(event);
  if (!type) {
    return null;
  }
  const sessionKey = normalizeOptionalString(event.sessionKey);
  const sessionId = readEventStringData(event, "sessionId") ?? sessionKey;
  return {
    type,
    runId: event.runId,
    seq: event.seq,
    ts: event.ts,
    stream: event.stream,
    data: event.data,
    agentId: readEventStringData(event, "agentId") ?? config.agentId,
    hostId: readEventStringData(event, "hostId") ?? config.hostId,
    ...(sessionKey ? { sessionKey } : {}),
    ...(sessionId ? { sessionId } : {}),
    schemaVersion: 1,
  };
}

export function buildAgentEventsBatchRequest(
  config: AgentEventsForwarderConfig,
  events: BenchAgentEvent[],
): AgentEventsBatchRequest {
  return {
    endpoint: config.endpoint,
    headers: {
      authorization: `Bearer ${config.tenantApiKey}`,
      "content-type": "application/json",
    },
    body: {
      events,
    },
  };
}

async function sendAgentEventsBatch(request: AgentEventsBatchRequest): Promise<void> {
  const response = await fetch(request.endpoint, {
    method: "POST",
    headers: request.headers,
    body: JSON.stringify(request.body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`BenchAGI agent events ingestion failed with HTTP ${response.status}`);
  }
}

function resolveConfig(deps: AgentEventsForwarderDeps): AgentEventsForwarderConfig | null {
  return deps.config ?? deps.loadConfig?.() ?? loadAgentEventsForwarderConfig();
}

export function createAgentEventsForwarder(
  deps: AgentEventsForwarderDeps = {},
): AgentEventsForwarder | null {
  const config = resolveConfig(deps);
  if (!config?.enabled) {
    return null;
  }

  const register = deps.registerAgentEventListener ?? registerAgentEventListener;
  const sendBatch = deps.sendBatch ?? sendAgentEventsBatch;
  const setTimer = deps.setTimeout ?? setTimeout;
  const clearTimer = deps.clearTimeout ?? clearTimeout;
  const flushIntervalMs = config.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatchSize = config.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxQueueSize = Math.max(
    maxBatchSize,
    config.maxQueueSize ?? Math.max(maxBatchSize, DEFAULT_MAX_QUEUE_SIZE),
  );
  const pending: BenchAgentEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let flushPromise: Promise<void> | null = null;
  let droppedSinceLastWarning = 0;
  let lastDropWarningAt = 0;

  const clearScheduledFlush = () => {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
  };

  const reportError = (error: unknown) => {
    if (deps.onError) {
      deps.onError(error);
      return;
    }
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
      return;
    }
    console.warn(`[openclaw] agent observability forwarder: ${formatErrorMessage(error)}`);
  };

  const reportDroppedEvents = (count: number) => {
    droppedSinceLastWarning += count;
    if (process.env.NODE_ENV === "test" || process.env.VITEST === "true") {
      return;
    }
    const now = Date.now();
    if (lastDropWarningAt !== 0 && now - lastDropWarningAt < DROP_WARNING_INTERVAL_MS) {
      return;
    }
    const dropped = droppedSinceLastWarning;
    droppedSinceLastWarning = 0;
    lastDropWarningAt = now;
    console.warn(
      `[openclaw] observability: dropped ${String(dropped)} event${dropped === 1 ? "" : "s"}, endpoint backlog`,
    );
  };

  const drainOnce = async () => {
    if (pending.length === 0) {
      return;
    }
    const events = pending.splice(0, maxBatchSize);
    try {
      await sendBatch(buildAgentEventsBatchRequest(config, events));
    } catch (error) {
      reportError(error);
    }
  };

  const flush = async () => {
    clearScheduledFlush();
    flushPromise ??= (async () => {
      for (;;) {
        if (pending.length === 0) {
          return;
        }
        await drainOnce();
      }
    })().finally(() => {
      flushPromise = null;
    });
    await flushPromise;
  };

  const scheduleFlush = () => {
    if (timer || stopped) {
      return;
    }
    timer = setTimer(() => {
      timer = null;
      void flush();
    }, flushIntervalMs);
  };

  const enqueue = (event: BenchAgentEvent) => {
    const overflowCount = pending.length + 1 - maxQueueSize;
    if (overflowCount > 0) {
      pending.splice(0, overflowCount);
      reportDroppedEvents(overflowCount);
    }
    pending.push(event);
  };

  const unsubscribe = register((event) => {
    if (stopped) {
      return;
    }
    const mapped = buildBenchAgentEvent(event, config);
    if (!mapped) {
      return;
    }
    enqueue(mapped);
    if (pending.length >= maxBatchSize) {
      void flush();
      return;
    }
    scheduleFlush();
  });

  return {
    flush,
    flushAndStop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearScheduledFlush();
      unsubscribe();
      await flush();
      pending.length = 0;
    },
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      clearScheduledFlush();
      unsubscribe();
      pending.length = 0;
    },
    getPendingCount: () => pending.length,
  };
}

export function startAgentEventsForwarder(
  deps: AgentEventsForwarderDeps = {},
): AgentEventsForwarder | null {
  if (activeForwarderState.forwarder) {
    return activeForwarderState.forwarder;
  }
  if (activeForwarderState.startupAttempted && !deps.config && !deps.loadConfig) {
    return null;
  }
  activeForwarderState.startupAttempted = true;
  activeForwarderState.forwarder = createAgentEventsForwarder(deps);
  return activeForwarderState.forwarder;
}

export function resetAgentEventsForwarderForTest(): void {
  activeForwarderState.forwarder?.stop();
  activeForwarderState.forwarder = null;
  activeForwarderState.startupAttempted = false;
}

export async function stopAgentEventsForwarder(options?: { flush?: boolean }): Promise<void> {
  const forwarder = activeForwarderState.forwarder;
  activeForwarderState.forwarder = null;
  activeForwarderState.startupAttempted = false;
  if (!forwarder) {
    return;
  }
  if (options?.flush === true) {
    await forwarder.flushAndStop();
    return;
  }
  forwarder.stop();
}
