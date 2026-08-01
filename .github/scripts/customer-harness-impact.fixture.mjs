export const validImpact = Object.freeze({
  version: 1,
  components: [
    {
      kind: "relay",
      delivery: "signed-update",
      restart: "relay-and-gateway",
      rollback: "pinned-formulas",
    },
  ],
  compatibility: {
    kind: "requires-minimum-openclaw",
    minimumOpenClaw: "2026.6.11",
  },
  rollout: {
    strategy: "canary-cohorts",
    soakMinutes: 60,
    maxParallel: 1,
  },
  proof: {
    kind: "no-send-turn",
    checks: ["artifact-loaded", "gateway-rpc", "relay-heartbeat", "rollback-ready"],
  },
  humanGates: ["customer-canary"],
});

export const validRelease = Object.freeze({
  schemaVersion: 1,
  releaseId: "relay.2026-08-01.1",
  source: {
    repository: "BenchAGI/BenchAGI_Mono_Repo",
    commit: "a".repeat(40),
  },
  artifactSha256: "b".repeat(64),
  impact: validImpact,
});
