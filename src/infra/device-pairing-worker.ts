import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { reserveWorkerEnvironmentNativePublication } from "../gateway/worker-environments/store-native-publication.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { DevicePairingAdmissionFacts } from "./device-pairing-admission.types.js";
import { invalidatePairedCardRendererCache } from "./device-pairing-card-renderer.js";
import { withDevicePairingLock } from "./device-pairing-lock.js";
import { captureDevicePairingPublication } from "./device-pairing-publication.js";
import type {
  DevicePairingCommitReceipt,
  DevicePairingNodeApprovalPublication,
} from "./device-pairing-read.types.js";
import { listDevicePairingStoreRecordsReadOnly } from "./device-pairing-store-readonly.js";
import type { DevicePairingWorkerOperations } from "./device-pairing-worker-contract.js";
import type { PairedDevice } from "./device-pairing.types.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerOperationAdmission,
} from "./sqlite-worker-operation-admission.js";

export const DevicePairingAuthorityRefusedError = resolveGlobalSingleton(
  Symbol.for("openclaw.devicePairingAuthorityRefusedError"),
  () =>
    class extends Error {
      constructor(message = "Device pairing authority changed") {
        super(message);
      }
    },
);

// The broker owns this private channel; domain kernels supply the discriminated facts.
function admissionFacts(value: unknown): DevicePairingAdmissionFacts[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => isRecord(entry) && typeof entry.kind === "string")
  ) {
    throw new Error("Invalid pairing admission facts");
  }
  for (const entry of value) {
    if (
      (entry.kind === "bootstrap.cloudWorkerSetup" &&
        (typeof entry.environmentId !== "string" ||
          typeof entry.setupId !== "string" ||
          typeof entry.credentialDigest !== "string" ||
          typeof entry.provisionOperationId !== "string" ||
          typeof entry.ownerEpoch !== "number")) ||
      ((entry.kind === "bootstrap.consume" || entry.kind === "bootstrap.token") &&
        typeof entry.expiresAtMs !== "number")
    ) {
      throw new Error("Invalid pairing admission facts");
    }
  }
  // SAFETY: This private broker port only accepts the admitted backend's typed pairing facts.
  return value as DevicePairingAdmissionFacts[];
}

function nodeApprovalPublication(
  value: unknown,
  command: { type: string; input: unknown },
  changed: DevicePairingCommitReceipt["changed"],
): DevicePairingNodeApprovalPublication | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    command.type !== "node.approve" ||
    !isRecord(command.input) ||
    typeof value.requestId !== "string" ||
    value.requestId !== command.input.requestId ||
    typeof value.nodeId !== "string" ||
    typeof value.pairingIdentity !== "string" ||
    typeof value.nextPairingGeneration !== "string" ||
    (value.previousPairingGeneration !== undefined &&
      (typeof value.previousPairingGeneration !== "string" ||
        value.previousPairingGeneration === value.nextPairingGeneration)) ||
    !isRecord(value.surface) ||
    !Array.isArray(value.surface.caps) ||
    !value.surface.caps.every((entry) => typeof entry === "string") ||
    !Array.isArray(value.surface.commands) ||
    !value.surface.commands.every((entry) => typeof entry === "string")
  ) {
    throw new Error("Invalid pairing node approval receipt");
  }
  const bindings = changed.filter((entry) => entry.deviceId === value.nodeId);
  if (
    bindings.length !== 1 ||
    bindings[0]?.binding?.identity !== value.pairingIdentity ||
    bindings[0]?.binding?.generation !== value.nextPairingGeneration
  ) {
    throw new Error("Pairing node approval differs from its committed binding");
  }
  let permissions: Record<string, boolean> | undefined;
  if (value.surface.permissions !== undefined) {
    if (!isRecord(value.surface.permissions)) {
      throw new Error("Invalid pairing node approval permissions");
    }
    const entries: [string, boolean][] = [];
    for (const [key, allowed] of Object.entries(value.surface.permissions)) {
      if (typeof allowed !== "boolean") {
        throw new Error("Invalid pairing node approval permissions");
      }
      entries.push([key, allowed]);
    }
    permissions = Object.fromEntries(entries);
  }
  return {
    requestId: value.requestId,
    nodeId: value.nodeId,
    pairingIdentity: value.pairingIdentity,
    nextPairingGeneration: value.nextPairingGeneration,
    ...(value.previousPairingGeneration !== undefined
      ? { previousPairingGeneration: value.previousPairingGeneration }
      : {}),
    surface: {
      caps: value.surface.caps,
      commands: value.surface.commands,
      permissions,
    },
  };
}

function commitReceipt(
  value: unknown,
  command: { type: string; input: unknown },
): DevicePairingCommitReceipt {
  if (
    !isRecord(value) ||
    value.kind !== "devicePairing" ||
    typeof value.beforeRevision !== "string" ||
    typeof value.revision !== "string" ||
    !Array.isArray(value.changed) ||
    !value.changed.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.deviceId === "string" &&
        (entry.binding === null ||
          (isRecord(entry.binding) &&
            typeof entry.binding.identity === "string" &&
            (entry.binding.generation === undefined ||
              typeof entry.binding.generation === "string"))),
    )
  ) {
    throw new Error("Invalid pairing commit receipt");
  }
  let tokensReplaced: DevicePairingCommitReceipt["tokensReplaced"];
  if (value.tokensReplaced !== undefined) {
    const replaced = value.tokensReplaced;
    if (
      !isRecord(replaced) ||
      typeof replaced.deviceId !== "string" ||
      !Array.isArray(replaced.roles) ||
      !replaced.roles.every((role) => typeof role === "string")
    ) {
      throw new Error("Invalid pairing token replacement receipt");
    }
    tokensReplaced = { deviceId: replaced.deviceId, roles: replaced.roles };
  }
  let workerEnvironment: DevicePairingCommitReceipt["workerEnvironment"];
  if (value.workerEnvironment !== undefined) {
    const environment = value.workerEnvironment;
    if (
      !isRecord(environment) ||
      typeof environment.environmentId !== "string" ||
      typeof environment.nodeDeviceId !== "string" ||
      typeof environment.updatedAtMs !== "number"
    ) {
      throw new Error("Invalid pairing worker-environment receipt");
    }
    workerEnvironment = {
      environmentId: environment.environmentId,
      nodeDeviceId: environment.nodeDeviceId,
      updatedAtMs: environment.updatedAtMs,
    };
  }
  const changed = value.changed.map((entry) => ({
    deviceId: entry.deviceId,
    binding:
      entry.binding === null
        ? null
        : {
            identity: entry.binding.identity,
            ...(entry.binding.generation === undefined
              ? {}
              : { generation: entry.binding.generation }),
          },
  }));
  const nodeApproval = nodeApprovalPublication(value.nodeApproval, command, changed);
  return {
    kind: "devicePairing",
    beforeRevision: value.beforeRevision,
    revision: value.revision,
    ...(tokensReplaced ? { tokensReplaced } : {}),
    ...(workerEnvironment ? { workerEnvironment } : {}),
    ...(nodeApproval ? { nodeApproval } : {}),
    changed,
  };
}

export function executeDevicePairingMutation<Key extends keyof DevicePairingWorkerOperations>(
  command: { type: Key; input: DevicePairingWorkerOperations[Key]["input"] },
  options: {
    baseDir?: string;
    context?: OpenClawStateWorkerContext;
    assertCurrent?: () => void;
    admit?: (facts: DevicePairingAdmissionFacts) => void;
    onTokensReplaced?: (deviceId: string, roles: readonly string[]) => void;
    onNodeApproval?: (approval: DevicePairingNodeApprovalPublication) => void;
    /** Map a refused operation only after its admission and publication have settled. */
    onAuthorityRefused?: () => DevicePairingWorkerOperations[Key]["output"];
  } = {},
): Promise<DevicePairingWorkerOperations[Key]["output"]> {
  const context =
    options.context ??
    captureOpenClawStateWorkerContext(
      options.baseDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: options.baseDir } } : {},
    );
  const captured = structuredClone(command);
  const operation = withDevicePairingLock(async () => {
    context.admission.assertCurrent();
    options.assertCurrent?.();
    // Join codes and retained setup cleanup cannot change paired-device authority.
    const publication =
      captured.type === "devicePairing.registerJoinCode" ||
      captured.type === "devicePairing.redeemJoinCode" ||
      captured.type === "bootstrap.prune"
        ? undefined
        : captureDevicePairingPublication(context.admission);
    const mutation = publication?.beginMutation();
    let admission: SqliteWorkerOperationAdmission | undefined;
    let published = false;
    let publishEnvironment: ReturnType<typeof reserveWorkerEnvironmentNativePublication>;
    const install = () => {
      if (!mutation) {
        return;
      }
      const committed = admission?.committed;
      if (committed && !published) {
        const receipt = commitReceipt(committed.facts, captured);
        const environment = receipt.workerEnvironment;
        let environmentPublished = false;
        if (environment && publishEnvironment) {
          context.admission.assertCurrent();
          environmentPublished = publishEnvironment(environment.environmentId, {
            nodeDeviceId: environment.nodeDeviceId,
            updatedAtMs: environment.updatedAtMs,
          });
        }
        // A callback can throw or read publication recursively; the commit is already installed.
        published = true;
        mutation.publish(receipt);
        // Transfer the exact live surface before projections or callers can
        // observe the newly committed generation and retire the old session.
        if (receipt.nodeApproval) {
          options.onNodeApproval?.(receipt.nodeApproval);
        }
        invalidatePairedCardRendererCache();
        if (environmentPublished) {
          sessionChanges.emit({ all: true, scope: "worker-environments" });
        }
        if (receipt.tokensReplaced) {
          options.onTokensReplaced?.(receipt.tokensReplaced.deviceId, receipt.tokensReplaced.roles);
        }
      }
    };
    const removeService = publication?.servicePending(install);
    try {
      return await runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          try {
            const result = await scope.execute(captured);
            if (captured.type === "bootstrap.prune" && result === 0) {
              context.admission.assertCurrent();
              options.assertCurrent?.();
            }
            return result;
          } finally {
            install();
          }
        },
        {
          assertCurrent: options.assertCurrent,
          createAdmission: () => {
            let committed = false;
            admission = createSqliteWorkerOperationAdmission((request, grant) => {
              if (committed || (request.stage !== "transaction" && request.stage !== "commit")) {
                throw new Error("Pairing admission requested out of order");
              }
              context.admission.assertCurrent();
              options.assertCurrent?.();
              for (const fact of admissionFacts(request.facts)) {
                options.admit?.(fact);
              }
              if (request.stage === "commit" && captured.type === "bootstrap.consume") {
                publishEnvironment = reserveWorkerEnvironmentNativePublication(
                  context.admission.identity,
                );
              }
              if (!grant()) {
                throw new DevicePairingAuthorityRefusedError();
              }
              committed = request.stage === "commit";
            });
            return { admission, nativeLocations: [context.admission.databasePath] };
          },
        },
      );
    } finally {
      try {
        install();
      } finally {
        mutation?.finish(!admission || admission.settlement?.kind === "completed");
        removeService?.();
      }
    }
  });
  const onAuthorityRefused = options.onAuthorityRefused;
  return onAuthorityRefused
    ? operation.catch((error: unknown) => {
        if (error instanceof DevicePairingAuthorityRefusedError) {
          return onAuthorityRefused();
        }
        throw error;
      })
    : operation;
}

/** Start the privileged effect in the same interval that publishes its pairing facts. */
export async function withCurrentDevicePairingSnapshot<T>(
  baseDir: string | undefined,
  prepare: (paired: readonly PairedDevice[]) => { start: () => T | Promise<T> } | undefined,
  preparePublication?: () => Promise<void>,
): Promise<T | undefined> {
  const begun = await withDevicePairingLock(async () => {
    const { paired } = await listDevicePairingStoreRecordsReadOnly(baseDir, true);
    if (preparePublication) {
      await preparePublication();
    }
    const action = prepare(paired);
    return { value: action?.start() };
  });
  return begun.value;
}
