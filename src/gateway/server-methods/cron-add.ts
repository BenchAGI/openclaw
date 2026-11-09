import {
  ErrorCodes,
  errorShape,
  validateCronAddParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { tryResolveCronJobEffectiveAgentId } from "../../cron/agent-id.js";
import { assertValidCronCreateDelivery } from "../../cron/delivery-channel-validation.js";
import { resolveCronDeliveryPreview } from "../../cron/delivery-preview.js";
import { cronAddResultReadView } from "../../cron/job-read-view.js";
import type { CronRuntimeAuthority } from "../../cron/runtime-authority.js";
import { CronJobsStoreChangedError } from "../../cron/store/save-error.js";
import { cronJobUsesToolRuntime } from "../../cron/tools-allow.js";
import type { CronJobCreate } from "../../cron/types.js";
import { validateScheduleTimestamp } from "../../cron/validate-timestamp.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  applyCronCreateCallerScopeDefault,
  cronCreateMatchesCallerScope,
  cronJobMatchesDeclarationScope,
  readCronCallerScope,
  resolveCronCreatorAuthorityCapture,
  resolveCronMutationCommitGuard,
  resolveCronScheduledToolPolicyForCaller,
} from "./cron-caller-scope.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";
import {
  captureCronCreatorSession,
  requiresExplicitAgentRuntimeToolsAllow,
  normalizeCronAddRequest,
  assertCronDoesNotTargetAgentHarness,
} from "./cron-input-validation.js";
import { respondInvalidCronParams, respondRefusedCronAgent } from "./cron-job-access.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

export const cronAddHandler: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
  sessionMutationCommitGuard,
  hasCurrentClientAuthority,
}) => {
  let candidate: unknown;
  let normalizedJob: CronJobCreate | null;
  let enabledExplicit: boolean;
  try {
    ({ candidate, normalizedJob, enabledExplicit } = normalizeCronAddRequest(params));
  } catch (err) {
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  }
  if (!assertValidParams(candidate, validateCronAddParams, "cron.add", respond)) {
    return;
  }
  if (!normalizedJob) {
    respondInvalidCronParams(respond, "cron.add", "expected a cron create object");
    return;
  }
  const callerScope = readCronCallerScope(client);
  const { createOnly, agentId, sessionKey, ...createInput } = candidate;
  // Public null scope values mean default/absent, as the service's create owner
  // already normalizes them. Keep target/default types from the same canonical
  // normalization; enabledExplicit separately preserves omitted update enablement.
  const jobCreate = applyCronCreateCallerScopeDefault(
    {
      ...createInput,
      agentId: agentId ?? undefined,
      sessionKey: sessionKey ?? undefined,
      sessionTarget: normalizedJob.sessionTarget,
      enabled: normalizedJob.enabled,
    },
    callerScope,
  );
  const {
    assertCurrent: assertCreatorSessionCurrent,
    assertOperatorSourceCurrent,
    ...creatorOptions
  } = captureCronCreatorSession(jobCreate, callerScope, client);
  let captureRuntimeAuthority: (() => CronRuntimeAuthority | undefined) | undefined;
  let assertCapturedAuthorityCurrent: (() => void) | undefined;
  try {
    const capture = resolveCronCreatorAuthorityCapture(callerScope);
    captureRuntimeAuthority = capture?.captureRuntimeAuthority;
    assertCapturedAuthorityCurrent = capture?.assertCurrent;
  } catch (err) {
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  }
  const assertMutationCurrent = resolveCronMutationCommitGuard(client, context, undefined, {
    sessionMutationCommitGuard,
    hasCurrentClientAuthority,
  });
  const commitGuard = () => {
    assertMutationCurrent?.();
    assertCapturedAuthorityCurrent?.();
    assertCreatorSessionCurrent();
    assertOperatorSourceCurrent?.();
  };
  const cfg = context.getRuntimeConfig();
  if (
    !cronCreateMatchesCallerScope({
      job: jobCreate,
      callerScope,
      defaultAgentId: context.cron.getDefaultAgentId(),
    })
  ) {
    respondInvalidCronParams(respond, "cron.add", "job agentId outside caller scope");
    return;
  }
  if (requiresExplicitAgentRuntimeToolsAllow({ job: jobCreate, callerScope })) {
    respondInvalidCronParams(
      respond,
      "cron.add",
      "agent-runtime tool jobs require an explicit payload.toolsAllow cap",
    );
    return;
  }
  const timestampValidation = validateScheduleTimestamp(jobCreate.schedule);
  if (!timestampValidation.ok) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, timestampValidation.message));
    return;
  }
  if (
    respondRefusedCronAgent(
      tryResolveCronJobEffectiveAgentId(jobCreate, context.cron.getDefaultAgentId()),
      respond,
    )
  ) {
    return;
  }
  try {
    assertCronDoesNotTargetAgentHarness(jobCreate);
    await assertValidCronCreateDelivery(cfg, jobCreate);
  } catch (err) {
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  }
  // Resolve before the durable add. A preview failure after commit would make a safe retry
  // create a duplicate job.
  const previewContext = { cfg, defaultAgentId: context.cron.getDefaultAgentId() };
  const deliveryPreview = await resolveCronDeliveryPreview({
    ...previewContext,
    job: { ...jobCreate, sourceConversation: creatorOptions.sourceConversation },
  });
  let result: Awaited<ReturnType<typeof context.cron.add>>;
  try {
    result = await context.cron.add(jobCreate, {
      enabledExplicit,
      ...(createOnly === true ? { createOnly: true } : {}),
      ...creatorOptions,
      commitGuard,
      ...(captureRuntimeAuthority ? { captureRuntimeAuthority } : {}),
      matchesExisting: (job) =>
        cronJobMatchesDeclarationScope({
          job,
          input: jobCreate,
          callerScope,
          defaultAgentId: context.cron.getDefaultAgentId(),
        }),
      ...(cronJobUsesToolRuntime(jobCreate)
        ? {
            scheduledToolPolicy: resolveCronScheduledToolPolicyForCaller(callerScope),
            ...(callerScope?.toolsAllowProvenance
              ? { toolsAllowProvenance: callerScope.toolsAllowProvenance }
              : {}),
            ...(callerScope?.toolsAllowExecTarget
              ? { toolsAllowExecTarget: callerScope.toolsAllowExecTarget }
              : {}),
          }
        : {}),
    });
  } catch (err) {
    if (createOnly && err instanceof CronJobsStoreChangedError) {
      respondInvalidCronParams(
        respond,
        "cron.add",
        "create-only declaration conflicted; review the current caller scope before retrying",
      );
      return;
    }
    if (
      !(err instanceof TypeError) &&
      !(err instanceof RangeError) &&
      !isCronInvalidRequestError(err)
    ) {
      throw err;
    }
    respondInvalidCronParams(respond, "cron.add", formatErrorMessage(err));
    return;
  }
  const job = "job" in result ? result.job : result;
  context.logGateway.info("cron: job added", {
    jobId: job.id,
    declarationKey: job.declarationKey,
    schedule: jobCreate.schedule,
  });
  respond(
    true,
    cronAddResultReadView({
      result,
      deliveryPreview:
        "job" in result && !result.created
          ? await resolveCronDeliveryPreview({ ...previewContext, job })
          : deliveryPreview,
    }),
    undefined,
  );
};
