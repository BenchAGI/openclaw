// Defines plugin approval request/resolution payloads and actions.
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { summarizeApprovalScope, type ApprovalScope } from "./approval-scope.js";
import type { ExecApprovalDecision } from "./exec-approvals.js";

// Plugin approval types and renderers mirror exec approval decisions while
// keeping plugin-facing request text and action metadata separate.
/** Button/action metadata shown with a plugin approval request. */
export type PluginApprovalActionView = {
  kind?: "command" | "decision";
  label: string;
  command: string;
  decision?: ExecApprovalDecision;
  style?: "primary" | "secondary" | "success" | "danger";
};

/** Gateway-minted placement identity; plugin and RPC callers never supply this authority. */
type PluginApprovalPlacementGrantBinding = {
  pluginId: string;
  command: string;
  approvalScope: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  nodeId: string;
  pairingGeneration: string;
  environmentId: string;
  ownerEpoch: number;
  placementGeneration: number;
  cwd: string;
};

/** Request payload supplied by plugin approval callers. */
export type PluginApprovalRequestPayload = {
  pluginId?: string | null;
  title: string;
  description: string;
  detail?: string | null;
  severity?: "info" | "warning" | "critical" | null;
  /** Owner-declared blast-radius facts; display-only, never authorization. */
  scope?: ApprovalScope | null;
  toolName?: string | null;
  toolCallId?: string | null;
  /** Exact MCP persistence intent; the host separately binds live tool-call proof. */
  mcpTool?: { server: string; tool: string };
  allowedDecisions?: readonly ExecApprovalDecision[] | null;
  /** Trusted in-process metadata; public Gateway callers cannot submit this field. */
  externalResolution?: {
    label: string;
    decisions?: readonly ("allow-once" | "allow-always")[];
  } | null;
  actions?: readonly PluginApprovalActionView[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
  /** Host-derived source run; never accepted from plugin approval RPC params. */
  runId?: string | null;
  /** Host-derived grant binding; never accepted from plugin approval RPC params. */
  placementGrant?: PluginApprovalPlacementGrantBinding | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
};

/** Timed plugin approval request persisted while awaiting a decision. */
export type PluginApprovalRequest = {
  /** Descriptive wire metadata; readers derive it from the payload when absent. */
  approvalKind?: "plugin";
  id: string;
  request: PluginApprovalRequestPayload;
  createdAtMs: number;
  expiresAtMs: number;
};

/** Resolved plugin approval decision plus optional request snapshot. */
export type PluginApprovalResolved = {
  id: string;
  decision: ExecApprovalDecision;
  resolvedBy?: string | null;
  ts: number;
  request?: PluginApprovalRequestPayload;
};

export const DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_APPROVAL_TIMEOUT_MS = 600_000;

/**
 * Assumed idle budget of the host turn runtime, in ms.
 *
 * The Codex app-server ends a turn after a period without activity and reports
 * `turn idle timed out waiting for turn/completed`. An approval wait is silent by
 * nature, so a wait longer than that budget is not a risk — it is a guarantee: the
 * turn is killed while it is correctly waiting for a person, and the user gets
 * "Codex stopped before confirming the turn was complete" instead of an answer.
 *
 * Observed 2026-08-01: a 119,977 ms approval wait against a 60,000 ms budget ended
 * the turn with no recoverable reply. It was not unlucky; it was arithmetic.
 *
 * WHY 60_000, AND WHY MIRRORED RATHER THAN IMPORTED: the real timer is
 * `turnCompletionIdleTimeoutMs`, a per-run app-server option that defaults to 60_000
 * (extensions/codex/src/app-server/config.ts:677, enforced in
 * attempt-turn-watches.ts:129). That app-server lives in the `@openclaw/codex`
 * extension package, and core `src/` must not depend on an extension, so the value
 * cannot be imported without inverting the dependency. It is mirrored here as an
 * assumed default and overridden per-runtime via the env var below. If the app-server
 * default ever changes, this constant and that config default must move together —
 * approval-wait-ceiling.test.ts pins the relationship so the drift is caught.
 *
 * Override via OPENCLAW_TURN_IDLE_BUDGET_MS for runtimes that configure a different
 * turnCompletionIdleTimeoutMs, or that have no idle killer at all — set 0 to disable
 * clamping entirely and restore the full requested wait.
 */
export const DEFAULT_TURN_IDLE_BUDGET_MS = 60_000;

/**
 * Headroom reserved inside the budget so that when an approval times out, the agent
 * still has time to compose and deliver a real reply — which itself counts as
 * activity and settles the turn cleanly. Without this the wait could expire at the
 * exact moment the turn dies and still strand the user.
 */
export const TURN_IDLE_REPLY_RESERVE_MS = 15_000;

function resolveTurnIdleBudgetMs(): number {
  const raw = process.env.OPENCLAW_TURN_IDLE_BUDGET_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_TURN_IDLE_BUDGET_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_TURN_IDLE_BUDGET_MS;
  }
  return Math.floor(parsed);
}

/**
 * Largest approval wait that still resolves inside the host turn budget.
 *
 * Deliberately a CEILING, not a replacement default: a caller asking for less than
 * this keeps its own value, and a runtime with no idle killer
 * (OPENCLAW_TURN_IDLE_BUDGET_MS=0) keeps the full requested wait. The goal is the
 * longest window that can actually be answered, not the shortest wait.
 */
export function resolveApprovalWaitCeilingMs(): number {
  const budget = resolveTurnIdleBudgetMs();
  if (budget <= 0) {
    return MAX_PLUGIN_APPROVAL_TIMEOUT_MS;
  }
  const ceiling = budget - TURN_IDLE_REPLY_RESERVE_MS;
  // A budget at or below the reserve leaves no safe window; fall back to half of it
  // rather than returning zero or negative and blocking approvals outright.
  return ceiling > 0 ? ceiling : Math.max(1_000, Math.floor(budget / 2));
}
export const PLUGIN_APPROVAL_TITLE_MAX_LENGTH = 80;
export const PLUGIN_APPROVAL_DESCRIPTION_MAX_LENGTH = 512;
export const PLUGIN_APPROVAL_DETAIL_MAX_LENGTH = 16_384;
const PLUGIN_APPROVAL_DETAIL_TRUNCATION_SUFFIX = "…[truncated]";
export const DEFAULT_PLUGIN_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

/** Caps reviewer-only plugin detail by Unicode code point without splitting surrogate pairs. */
export function truncatePluginApprovalDetail(value: string): string {
  if (value.length <= PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) {
    return value;
  }
  const contentLimit =
    PLUGIN_APPROVAL_DETAIL_MAX_LENGTH - Array.from(PLUGIN_APPROVAL_DETAIL_TRUNCATION_SUFFIX).length;
  let codePointCount = 0;
  let contentCodeUnitLength = 0;
  for (const char of value) {
    codePointCount += 1;
    if (codePointCount <= contentLimit) {
      contentCodeUnitLength += char.length;
    }
    if (codePointCount > PLUGIN_APPROVAL_DETAIL_MAX_LENGTH) {
      return `${truncateUtf16Safe(value, contentCodeUnitLength)}${PLUGIN_APPROVAL_DETAIL_TRUNCATION_SUFFIX}`;
    }
  }
  return value;
}

/** Clamp a plugin approval timeout to the supported runtime bounds. */
export function resolvePluginApprovalTimeoutMs(value: unknown): number {
  const candidate =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : DEFAULT_PLUGIN_APPROVAL_TIMEOUT_MS;
  // Deliberately NOT clamped to resolveApprovalWaitCeilingMs. This function also
  // serves gateway paths that run outside any host turn — node-invoke-plugin-policy.ts
  // and server-methods/plugin-approval.ts — where a long wait is correct and no idle
  // killer is counting. Clamping here would silently shorten approvals that were never
  // at risk. Only the in-turn caller applies the ceiling; see
  // resolvePluginToolApprovalTimeoutMs in agents/agent-tools.before-tool-call.ts.
  return Math.min(MAX_PLUGIN_APPROVAL_TIMEOUT_MS, Math.max(1, Math.floor(candidate)));
}

/** Format an approval decision for user-facing messages. */
export function approvalDecisionLabel(decision: ExecApprovalDecision): string {
  if (decision === "allow-once") {
    return "allowed once";
  }
  if (decision === "allow-always") {
    return "allowed always";
  }
  return "denied";
}

/** Resolve explicit plugin approval decisions or fall back to defaults. */
export function resolvePluginApprovalRequestAllowedDecisions(params?: {
  allowedDecisions?: readonly ExecApprovalDecision[] | readonly string[] | null;
}): readonly ExecApprovalDecision[] {
  const explicit: ExecApprovalDecision[] = [];
  if (Array.isArray(params?.allowedDecisions)) {
    for (const decision of params.allowedDecisions) {
      if (
        (decision === "allow-once" || decision === "allow-always" || decision === "deny") &&
        !explicit.includes(decision)
      ) {
        explicit.push(decision);
      }
    }
  }
  return explicit.length > 0 ? explicit : DEFAULT_PLUGIN_APPROVAL_DECISIONS;
}

/** Build the pending plugin approval message. */
export function buildPluginApprovalRequestMessage(
  request: PluginApprovalRequest,
  nowMsValue: number,
): string {
  const lines: string[] = [];
  const severity = request.request.severity ?? "warning";
  const icon = severity === "critical" ? "🚨" : severity === "info" ? "ℹ️" : "🛡️";
  lines.push(`${icon} Plugin approval required`);
  lines.push(`Title: ${request.request.title}`);
  // Reviewer-only detail stays off channel messages; channels receive the bounded description.
  lines.push(`Description: ${request.request.description}`);
  if (request.request.scope) {
    lines.push(`Scope: ${summarizeApprovalScope(request.request.scope)}`);
  }
  if (request.request.toolName) {
    lines.push(`Tool: ${request.request.toolName}`);
  }
  if (request.request.pluginId) {
    lines.push(`Plugin: ${request.request.pluginId}`);
  }
  if (request.request.agentId) {
    lines.push(`Agent: ${request.request.agentId}`);
  }
  lines.push(`ID: ${request.id}`);
  const expiresIn = Math.max(0, Math.round((request.expiresAtMs - nowMsValue) / 1000));
  lines.push(`Expires in: ${expiresIn}s`);
  lines.push(
    `Reply with: /approve ${request.id} ${resolvePluginApprovalRequestAllowedDecisions(
      request.request,
    ).join("|")}`,
  );
  return lines.join("\n");
}

/** Build the plugin approval resolution message. */
export function buildPluginApprovalResolvedMessage(resolved: PluginApprovalResolved): string {
  const base = `✅ Plugin approval ${approvalDecisionLabel(resolved.decision)}.`;
  const by = resolved.resolvedBy ? ` Resolved by ${resolved.resolvedBy}.` : "";
  return `${base}${by} ID: ${resolved.id}`;
}

/** Build the plugin approval expiration message. */
export function buildPluginApprovalExpiredMessage(request: PluginApprovalRequest): string {
  return `⏱️ Plugin approval expired. ID: ${request.id}`;
}
