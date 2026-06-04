---
summary: "BenchAGI cloud sync for Workboard cards and Skill Workshop proposals"
read_when:
  - You are connecting a BenchAGI customer harness to the BenchAGI cloud Forge
  - You are enabling or configuring the bench-sync plugin
  - You need to understand what leaves the customer machine and what never does
title: "bench-sync plugin"
---

The bench-sync plugin (BenchAGI fork extension) keeps a customer gateway's
local Workboard and Skill Workshop in sync with the BenchAGI cloud:

- **UP — Workboard mirror:** customer-visible Workboard cards are projected
  and pushed to `POST /api/v1/instances/{id}/agent-tasks/sync`, where they
  appear in the BenchAGI Forge **Work** tab.
- **UP — Skill proposal mirror:** Skill Workshop proposals (pending when
  `mirrorPendingUp`, plus all status changes) are pushed to
  `POST /api/v1/instances/{id}/skill-proposals/sync` for operator review at
  `/app/admin/skills`.
- **DOWN — directives:** the gateway polls
  `GET /api/v1/instances/{id}/sync/directives` and enacts
  `skill_proposal_decision` directives (apply / reject / quarantine) through
  the local Skill Workshop service, then acks each one. The cloud decision
  route is admin-gated; the local apply path still reruns the scanner.

All networking is **gateway-initiated** (the cloud never connects in). Auth
is the instance API key sent as `X-API-Key`, resolved from a SecretRef —
never plaintext in config. All request URLs are origin-pinned to
`gateway.benchCloud.apiBaseUrl`.

## What never leaves the machine

- Cards labeled `internal` (or `metadata.visibility: "internal"`) are dropped
  by the projection step — they are not uploaded at all.
- Claim tokens are redacted; only claim ownership metadata syncs.
- Attachment blobs never upload.
- Skill proposal support files sync as metadata (path/folder/bytes/hash)
  only; file bytes stay local.

## Configuration

```json5
{
  gateway: {
    benchCloud: {
      enabled: true,
      apiBaseUrl: "https://benchagi.com",
      instanceId: "<your-instance-id>",
      // SecretRef to the instance API key (env/file/exec) — required for sync
      apiKeyRef: { source: "env", id: "BENCH_INSTANCE_API_KEY" },
      workboardSync: { enabled: true, pollIntervalMs: 15000 },
      skillSync: { enabled: true, mirrorPendingUp: false },
    },
  },
  plugins: {
    entries: {
      "bench-sync": { enabled: true, config: {} },
      workboard: { enabled: true, config: {} },
    },
  },
}
```

Enable with:

```bash
openclaw plugins enable bench-sync
openclaw gateway restart
```

The service no-ops (debug log only) unless `gateway.benchCloud.enabled` and
at least one of `workboardSync.enabled` / `skillSync.enabled` are true.

## Durability

Sync state lives in `<state-dir>/bench-sync/cursor.json` (atomic writes):
per-card and per-proposal content hashes (unchanged items are never
re-pushed), the directive cursor, and a bounded ring of applied directive
ids (replay-safe across restarts — a re-delivered directive is acked
`skipped` without re-enacting). Push failures keep the cursor unadvanced
and retry with a capped skip-N-ticks backoff.

## Failure semantics

- A directive whose local enactment fails is acked `failed` with a redacted
  `{code, message}` and is **not retried automatically** — the cloud surfaces
  "Gateway reported failure" to the operator, who re-decides.
- If the Workboard store cannot be opened (plugin disabled/absent), the
  mirror logs once and skips; the gateway is unaffected.

## Related

- [Workboard plugin](/plugins/workboard)
- [Skill Workshop](/tools/skill-workshop)
