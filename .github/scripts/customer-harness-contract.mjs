import { createHash } from "node:crypto";

export const COMPONENT_KINDS = Object.freeze([
  "harness-bundle",
  "openclaw",
  "relay",
  "seat-kit",
  "slack-sidecar",
]);
export const DELIVERY_KINDS = Object.freeze([
  "channel-pull",
  "signed-update",
  "seat-kit",
  "sidecar-deploy",
]);
export const RESTART_SCOPES = Object.freeze([
  "none",
  "relay",
  "gateway",
  "relay-and-gateway",
  "sidecar",
]);
export const ROLLBACK_KINDS = Object.freeze([
  "previous-generation",
  "pinned-formulas",
  "previous-release",
  "disable-flag",
]);
export const COMPATIBILITY_KINDS = Object.freeze([
  "backward-compatible",
  "requires-minimum-openclaw",
  "breaking",
]);
export const PROOF_KINDS = Object.freeze(["no-send-turn", "read-only-health", "shadow-only"]);
export const PROOF_CHECKS = Object.freeze([
  "artifact-loaded",
  "delivery-ack",
  "gateway-rpc",
  "model-no-deliver",
  "relay-heartbeat",
  "rollback-ready",
  "slack-probe",
]);
export const HUMAN_GATES = Object.freeze([
  "credential",
  "customer-canary",
  "customer-send",
  "model",
  "provider",
  "scheduler-install",
  "schema",
]);

const SHA256 = /^[a-f0-9]{64}$/;
const OPENCLAW_VERSION = /^\d{4}\.\d{1,2}\.\d{1,3}(?:[-+][A-Za-z0-9.-]+)?$/;
const EXACT_FIELDS = Object.freeze([
  "version",
  "components",
  "compatibility",
  "rollout",
  "proof",
  "humanGates",
]);

function exactObject(value, fields, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const allowed = new Set(fields);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`Unexpected ${label} field: ${key}.`);
  }
  return true;
}

function uniqueEnumArray(value, allowed, label, errors, { required = true } = {}) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    errors.push(`${label} must be ${required ? "a non-empty" : "an"} array.`);
    return [];
  }
  const normalized = [];
  for (const item of value) {
    if (typeof item !== "string" || !allowed.includes(item)) {
      errors.push(`${label} contains unsupported value: ${String(item)}.`);
    } else {
      normalized.push(item);
    }
  }
  if (new Set(normalized).size !== normalized.length) {
    errors.push(`${label} must not contain duplicates.`);
  }
  return normalized;
}

export function validateHarnessImpactContract(contract) {
  const errors = [];
  if (!exactObject(contract, EXACT_FIELDS, "contract", errors)) {
    return { valid: false, errors };
  }
  if (contract.version !== 1) errors.push("version must be 1.");

  const components = [];
  if (!Array.isArray(contract.components) || contract.components.length === 0) {
    errors.push("components must be a non-empty array.");
  } else if (contract.components.length > COMPONENT_KINDS.length) {
    errors.push(`components must contain at most ${COMPONENT_KINDS.length} entries.`);
  } else {
    for (const [index, component] of contract.components.entries()) {
      const label = `components[${index}]`;
      if (!exactObject(component, ["kind", "delivery", "restart", "rollback"], label, errors)) {
        continue;
      }
      if (!COMPONENT_KINDS.includes(component.kind)) {
        errors.push(`${label}.kind is unsupported.`);
      } else {
        components.push(component.kind);
      }
      if (!DELIVERY_KINDS.includes(component.delivery)) {
        errors.push(`${label}.delivery is unsupported.`);
      }
      if (!RESTART_SCOPES.includes(component.restart)) {
        errors.push(`${label}.restart is unsupported.`);
      }
      if (!ROLLBACK_KINDS.includes(component.rollback)) {
        errors.push(`${label}.rollback is unsupported.`);
      }
    }
  }
  if (new Set(components).size !== components.length) {
    errors.push("components must not repeat a component kind.");
  }

  if (exactObject(contract.compatibility, ["kind", "minimumOpenClaw"], "compatibility", errors)) {
    if (!COMPATIBILITY_KINDS.includes(contract.compatibility.kind)) {
      errors.push("compatibility.kind is unsupported.");
    }
    const minimum = contract.compatibility.minimumOpenClaw;
    if (contract.compatibility.kind === "requires-minimum-openclaw") {
      if (typeof minimum !== "string" || !OPENCLAW_VERSION.test(minimum)) {
        errors.push("compatibility.minimumOpenClaw must be a concrete OpenClaw version.");
      }
    } else if (minimum !== null) {
      errors.push("compatibility.minimumOpenClaw must be null unless a minimum is required.");
    }
  }

  if (
    exactObject(contract.rollout, ["strategy", "soakMinutes", "maxParallel"], "rollout", errors)
  ) {
    if (contract.rollout.strategy !== "canary-cohorts") {
      errors.push("rollout.strategy must be canary-cohorts.");
    }
    if (
      !Number.isSafeInteger(contract.rollout.soakMinutes) ||
      contract.rollout.soakMinutes < 15 ||
      contract.rollout.soakMinutes > 1_440
    ) {
      errors.push("rollout.soakMinutes must be an integer from 15 to 1440.");
    }
    if (
      !Number.isSafeInteger(contract.rollout.maxParallel) ||
      contract.rollout.maxParallel < 1 ||
      contract.rollout.maxParallel > 25
    ) {
      errors.push("rollout.maxParallel must be an integer from 1 to 25.");
    }
  }

  if (exactObject(contract.proof, ["kind", "checks"], "proof", errors)) {
    if (!PROOF_KINDS.includes(contract.proof.kind)) errors.push("proof.kind is unsupported.");
    const checks = uniqueEnumArray(contract.proof.checks, PROOF_CHECKS, "proof.checks", errors);
    for (const required of ["artifact-loaded", "rollback-ready"]) {
      if (!checks.includes(required)) errors.push(`proof.checks must include ${required}.`);
    }
    if (
      !checks.some((check) => ["gateway-rpc", "relay-heartbeat", "slack-probe"].includes(check))
    ) {
      errors.push("proof.checks must include a live runtime health check.");
    }
  }

  const humanGates = uniqueEnumArray(contract.humanGates, HUMAN_GATES, "humanGates", errors, {
    required: false,
  });
  if (!humanGates.includes("customer-canary")) {
    errors.push("humanGates must include customer-canary.");
  }
  if (contract.compatibility?.kind === "breaking" && !humanGates.includes("schema")) {
    errors.push("breaking compatibility requires the schema human gate.");
  }

  return {
    valid: errors.length === 0,
    errors,
    components,
  };
}

function stableSort(value) {
  if (Array.isArray(value)) {
    return value
      .map(stableSort)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableSort(value[key])]),
  );
}

export function harnessImpactContractSha256(contract) {
  const validation = validateHarnessImpactContract(contract);
  if (!validation.valid) {
    throw new Error(`invalid customer harness impact contract: ${validation.errors.join(" ")}`);
  }
  return createHash("sha256")
    .update(JSON.stringify(stableSort(contract)), "utf8")
    .digest("hex");
}

export function validateImmutableHarnessRelease(release) {
  const errors = [];
  if (
    !exactObject(
      release,
      ["schemaVersion", "releaseId", "source", "artifactSha256", "impact"],
      "release",
      errors,
    )
  ) {
    return { valid: false, errors };
  }
  if (release.schemaVersion !== 1) errors.push("release.schemaVersion must be 1.");
  if (
    typeof release.releaseId !== "string" ||
    !/^[a-z0-9]+(?:[._-][a-z0-9]+){1,15}$/.test(release.releaseId)
  ) {
    errors.push("release.releaseId must be a lowercase stable identifier.");
  }
  if (exactObject(release.source, ["repository", "commit"], "release.source", errors)) {
    if (
      typeof release.source.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(release.source.repository)
    ) {
      errors.push("release.source.repository must be owner/name.");
    }
    if (
      typeof release.source.commit !== "string" ||
      !/^[a-f0-9]{40}$/.test(release.source.commit)
    ) {
      errors.push("release.source.commit must be an exact 40-character Git commit.");
    }
  }
  if (typeof release.artifactSha256 !== "string" || !SHA256.test(release.artifactSha256)) {
    errors.push("release.artifactSha256 must be a lowercase SHA-256 digest.");
  }
  const impact = validateHarnessImpactContract(release.impact);
  errors.push(...impact.errors.map((error) => `release.impact: ${error}`));
  return { valid: errors.length === 0, errors };
}
