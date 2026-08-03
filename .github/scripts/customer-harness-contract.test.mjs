import assert from "node:assert/strict";
import test from "node:test";
import {
  harnessImpactContractSha256,
  validateHarnessImpactContract,
  validateImmutableHarnessRelease,
} from "./customer-harness-contract.mjs";
import { validImpact, validRelease } from "./customer-harness-impact.fixture.mjs";

test("accepts a complete fail-closed harness impact contract", () => {
  const result = validateHarnessImpactContract(validImpact);
  assert.equal(result.valid, true);
  assert.deepEqual(result.components, ["relay"]);
  assert.match(harnessImpactContractSha256(validImpact), /^[a-f0-9]{64}$/);
});

test("hashes contracts canonically when set-semantic arrays are reordered", () => {
  const impact = {
    ...validImpact,
    components: [
      ...validImpact.components,
      {
        kind: "openclaw",
        delivery: "channel-pull",
        restart: "gateway",
        rollback: "previous-release",
      },
    ],
    proof: {
      ...validImpact.proof,
      checks: [...validImpact.proof.checks, "slack-probe"],
    },
    humanGates: ["customer-canary", "scheduler-install"],
  };
  const reordered = {
    ...impact,
    components: [...impact.components].reverse(),
    proof: {
      ...impact.proof,
      checks: [...impact.proof.checks].reverse(),
    },
    humanGates: [...impact.humanGates].reverse(),
  };
  assert.equal(harnessImpactContractSha256(impact), harnessImpactContractSha256(reordered));
});

test("requires exact rollback and runtime proof before a rollout may exist", () => {
  const result = validateHarnessImpactContract({
    ...validImpact,
    proof: { kind: "no-send-turn", checks: ["artifact-loaded"] },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /rollback-ready/);
  assert.match(result.errors.join("\n"), /runtime health check/);
});

test("requires a concrete minimum version when compatibility depends on one", () => {
  const result = validateHarnessImpactContract({
    ...validImpact,
    compatibility: {
      kind: "requires-minimum-openclaw",
      minimumOpenClaw: null,
    },
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /concrete OpenClaw version/);
});

test("binds an immutable release to exact source and artifact hashes", () => {
  assert.equal(validateImmutableHarnessRelease(validRelease).valid, true);
  const invalid = validateImmutableHarnessRelease({
    ...validRelease,
    source: { ...validRelease.source, commit: "main" },
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /exact 40-character Git commit/);
});
