export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "@benchagi/openclaw/plugin-sdk/account-id";
export {
  createActionGate,
  jsonResult,
  readNumberParam,
  readReactionParams,
  readStringArrayParam,
  readStringParam,
  ToolAuthorizationError,
} from "@benchagi/openclaw/plugin-sdk/channel-actions";
export { buildChannelConfigSchema } from "@benchagi/openclaw/plugin-sdk/channel-config-primitives";
export type { ChannelPlugin } from "@benchagi/openclaw/plugin-sdk/channel-core";
export type {
  BaseProbeResult,
  ChannelDirectoryEntry,
  ChannelGroupContext,
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelOutboundAdapter,
  ChannelResolveKind,
  ChannelResolveResult,
  ChannelToolSend,
} from "@benchagi/openclaw/plugin-sdk/channel-contract";
export {
  formatLocationText,
  toLocationContext,
  type NormalizedLocation,
} from "@benchagi/openclaw/plugin-sdk/channel-location";
export { logInboundDrop, logTypingFailure } from "@benchagi/openclaw/plugin-sdk/channel-logging";
export { resolveAckReaction } from "@benchagi/openclaw/plugin-sdk/channel-feedback";
export type { ChannelSetupInput } from "@benchagi/openclaw/plugin-sdk/setup";
export type {
  OpenClawConfig,
  ContextVisibilityMode,
  DmPolicy,
  GroupPolicy,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export type { GroupToolPolicyConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";
export type { WizardPrompter } from "@benchagi/openclaw/plugin-sdk/matrix-runtime-shared";
export type { SecretInput } from "@benchagi/openclaw/plugin-sdk/secret-input";
export {
  GROUP_POLICY_BLOCKED_LABEL,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "@benchagi/openclaw/plugin-sdk/config-runtime";
export {
  addWildcardAllowFrom,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  moveSingleAccountChannelSectionToDefaultAccount,
  promptAccountId,
  promptChannelAccessConfig,
  splitSetupEntries,
} from "@benchagi/openclaw/plugin-sdk/setup";
export type { RuntimeEnv } from "@benchagi/openclaw/plugin-sdk/runtime";
export {
  assertHttpUrlTargetsPrivateNetwork,
  closeDispatcher,
  createPinnedDispatcher,
  isPrivateOrLoopbackHost,
  resolvePinnedHostnameWithPolicy,
  ssrfPolicyFromDangerouslyAllowPrivateNetwork,
  ssrfPolicyFromAllowPrivateNetwork,
  type LookupFn,
  type SsrFPolicy,
} from "@benchagi/openclaw/plugin-sdk/ssrf-runtime";
export { dispatchReplyFromConfigWithSettledDispatcher } from "@benchagi/openclaw/plugin-sdk/inbound-reply-dispatch";
export {
  ensureConfiguredAcpBindingReady,
  resolveConfiguredAcpBindingRecord,
} from "@benchagi/openclaw/plugin-sdk/acp-binding-runtime";
export {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  PAIRING_APPROVED_MESSAGE,
} from "@benchagi/openclaw/plugin-sdk/channel-status";
export {
  getSessionBindingService,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "@benchagi/openclaw/plugin-sdk/conversation-runtime";
export { resolveOutboundSendDep } from "@benchagi/openclaw/plugin-sdk/outbound-runtime";
export { resolveAgentIdFromSessionKey } from "@benchagi/openclaw/plugin-sdk/routing";
export { chunkTextForOutbound } from "@benchagi/openclaw/plugin-sdk/text-chunking";
export { createChannelReplyPipeline } from "@benchagi/openclaw/plugin-sdk/channel-reply-pipeline";
export { loadOutboundMediaFromUrl } from "@benchagi/openclaw/plugin-sdk/outbound-media";
export { normalizePollInput, type PollInput } from "@benchagi/openclaw/plugin-sdk/poll-runtime";
export { writeJsonFileAtomically } from "@benchagi/openclaw/plugin-sdk/json-store";
export {
  buildChannelKeyCandidates,
  resolveChannelEntryMatch,
} from "@benchagi/openclaw/plugin-sdk/channel-targets";
export {
  evaluateGroupRouteAccessForPolicy,
  resolveSenderScopedGroupPolicy,
} from "@benchagi/openclaw/plugin-sdk/channel-policy";
export {
  formatZonedTimestamp,
  type PluginRuntime,
  type RuntimeLogger,
} from "@benchagi/openclaw/plugin-sdk/matrix-runtime-shared";
export type { ReplyPayload } from "@benchagi/openclaw/plugin-sdk/reply-runtime";
// resolveMatrixAccountStringValues already comes from plugin-sdk/matrix.
// Re-exporting auth-precedence here makes Jiti try to define the same export twice.

export function buildTimeoutAbortSignal(params: { timeoutMs?: number; signal?: AbortSignal }): {
  signal?: AbortSignal;
  cleanup: () => void;
} {
  const { timeoutMs, signal } = params;
  if (!timeoutMs && !signal) {
    return { signal: undefined, cleanup: () => {} };
  }
  if (!timeoutMs) {
    return { signal, cleanup: () => {} };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(controller.abort.bind(controller), timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}
