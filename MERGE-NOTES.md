# Merge notes: upstream v2026.9.2 into fork main (feat/main-merge-upstream-2026.9.2)

Cory's ruling (2026-09-06 ~03:05Z): the customer base keeps the fork's own main line.
This branch is `git merge` of upstream `openclaw/openclaw` tag `v2026.9.2` (`3928bad9`)
into `BenchAGI/openclaw` main (`71138e06`, #109). Every fork commit #64–#109 stays in
history as-is; fork behavior is re-ported onto upstream's restructured modules.

## Method

- Merge base. Fork commit #93 (`8a40f582`, "merge: upstream v2026.6.11") is a
  single-parent squash of 7,102 files, so a naive merge produced 5,311 conflicts. The
  tag `v2026.6.11` (`e085fa1a`) was fetched and #93 was grafted locally as the merge it
  was (`git replace --graft 8a40f582 8a40f582^ e085fa1a`; the replace ref is **not**
  pushed). #93's tree differs from v2026.6.11 in exactly 228 fork files, so the graft is a
  faithful description. The merge base moved to `9e3a917d` and conflicts dropped to 399.
- 226 conflicted paths carried only 6.11 release-branch content (no fork-authored
  change) and took upstream: 158 as-is, 68 deletions.
- 173 paths carried a fork change next to an upstream change. Each was re-merged with
  the v2026.6.11 blob as the base and then hand re-ported; the resolutions are below.
- Rule applied throughout: fork behavior on top of upstream structure. Where upstream
  had already adopted the fork feature in evolved form, upstream's version was kept and
  the fork's file-level change dropped.

## Resolutions by fork feature (what survives, and where it now lives)

| Fork feature | Status on this base | Files |
|---|---|---|
| #63 Tier-1 retrieval-at-start (+ LLM reranker) | Re-ported. Config re-homed from `agents.defaults.memorySearch.query.{tier1,reranker}` to upstream's `memory.search.query.{tier1,reranker}` (and `agents.entries.*.memory.search…`). Runner injection moved from the monolithic `attempt.ts` into `run/attempt-bootstrap-prepare.ts`; CLI-backend injection into `cli-runner/prepare.ts`. `memory tier1` / `memory promote-file` CLI moved to `extensions/memory-core/src/cli-tier1.runtime.ts` (upstream turned `cli.runtime.ts` into a barrel). Secret targets renamed to `memory.search.query.reranker.apiKey` / `agents.entries.*.memory.search.query.reranker.apiKey`; collection lives in `src/secrets/runtime-config-collectors-memory.ts`; runtime activation in `src/cli/command-secret-targets.ts` (`getActiveMemoryRerankerSecretTargets`) + `src/agents/agent-runtime-config.ts`. Labels/help in `schema.labels.ts`, `schema.help.models.ts`. | `src/agents/tier1-retrieval.ts`, `src/agents/memory-search.ts`, `src/config/types.memory.ts`, `src/config/zod-schema.agent-runtime.ts`, tests re-homed |
| #65 local CLI seat capture | Re-ported into upstream's descriptor registry: `methods/core-descriptors.ts` row, `server-methods/core-handlers.ts` loader, `validator-registry.ts` validator, `schema-modules.ts` + `index.ts` exports. `packages/gateway-protocol/src/schema/types.ts` was deleted upstream; the types come from `schema/local-seat.ts`. | `src/gateway/server-methods/local-seat.ts` |
| #66 persistent fallback-mode banner | Re-homed from `agent-runner.ts` (now a one-line re-export) into `agent-runner-result-payloads.ts`; `mergeFallbackModeExecutionTrace` added to `fallback-mode-notice.ts`. Docs paragraph re-added to `docs/concepts/model-failover.md`. | |
| #68 SSE keepalive on `/v1/chat/completions` | Re-ported into `openai-http.ts`; config `gateway.http.endpoints.chatCompletions.sseKeepaliveIntervalMs` re-homed into `zod-schema.gateway.ts` / `types.gateway.ts` / help+labels. | |
| #70 `memory promote-file` | See #63 (same module). | |
| #71 thinkingLevel/reasoningLevel at `sessions.create` | Upstream already accepts `thinkingLevel`; `reasoningLevel` added to `schema/sessions-create.ts`, `session-create-service.ts`, `server-methods/sessions-create.ts`. `server-methods/sessions.ts` (fork's site) was deleted upstream. Test added to `server.sessions.create.test.ts`. | |
| #73 memory-wiki sibling-home prune guard | Re-ported into `source-sync-state.ts` (`localHomeDir`, `isSiblingHomeSourcePath`). | |
| #75 adopt provider starter model on key placement | Re-ported into `commands/models/auth.ts` using upstream's `ProviderAuthMethod.starterModel` (upstream's name for the fork's `defaultModel`); catalog check uses `plugin-sdk/agent-runtime.loadModelCatalog`. | |
| #77/#88/#89/#102 claude-cli ultracode backend | `ultracode` config moved to `src/plugins/cli-backend.types.ts`; `--settings '{"ultracode":true}'` injection in `extensions/anthropic/cli-shared.ts`; second backend registered in `register.runtime.ts`; manifest `cliBackends` lists `claude-cli-ultracode`. Sonnet 5 catalog entries already exist upstream. | |
| #78 wiki `canon/` page kind | Upstream did not have it. Kept in `markdown.ts`, `compile.ts`, `query.ts`, `status.ts` (upstream's recursive `walkMemoryWikiDirectory` covers subdirs), `wiki-overview.ts` (replaces deleted `memory-palace.ts`). | |
| #79 plan/review read-only tools on HTTP endpoints | `toolsAllow` threading re-ported into `openai-http.ts` and `openresponses-http.ts`. | `src/gateway/tools-mode.ts` |
| #80 claude-cli-* family dialect gate | Re-ported into `src/agents/cli-output-records.ts`; test re-cut as `cli-output-claude-cli-family.test.ts` (upstream split the old test file). | |
| #82 console C1 stream salvage + C3 ask_choice + cloud remote-brain bridge | `openai-http.ts` salvage/ask_choice re-ported. `execute.ts` ask_choice agent event already upstream. The chat.send cloud-brain bridge was re-homed from the monolithic `chat.ts` into `chat-send-agent-dispatch.ts` (remote turn replaces the local dispatch inside the admitted dispatch span; `cloudAuth` added to `ChatSendParamsSchema`; `gateway.benchCloud` config re-homed into `zod-schema.root-support.ts`/`zod-schema.gateway.ts`). **Needs live verification** on a Vault box: the fork's lifecycle-event broadcasts were not carried (upstream's admission/finalize lifecycle now owns cleanup). | `src/gateway/cloud-brain-bridge.ts`, `bench-cloud-client.ts` |
| #84 interactive web-chat watchdog (240 s) | Re-ported into `cli-runner/reliability.ts` (+ `messageChannel` threaded from `execute.ts`). | |
| #85 build-info `release` lineage | Re-ported into upstream's `resolveBuildInfo` (`scripts/write-build-info.ts`), test cases adapted. | |
| #87 LaunchAgent stderr to a real log | Re-ported into `src/daemon/launchd-service-files.ts` (upstream still nulled it) and `diagnostics.ts` now reads stderr on darwin. | |
| #92/#69/#83/#99 dependency floors | Upstream's floors exceed every fork floor (axios 1.19.0, fast-uri 4.1.4, tar 7.5.22, vitest 4.1.11, esbuild 0.28.2); `pnpm-workspace.yaml` is upstream's. Lockfile regenerated on Prime. | |
| #94 Slack requester membership gate for reads | **Not upstream.** Re-ported into `action-runtime.ts` (`SlackRequesterReadAuthority`, `assertSlackRequesterCanReadChannel`, `requireChannelEvidence` on downloads), `actions.ts` (`isSlackUserChannelMember`, `lacksSlackScopeProof.requireChannelEvidence`), `message-action-dispatch.ts` (authority producer on read-like actions). `actions.runtime.ts` was deleted upstream; the lazy action registry lives in `action-runtime.ts`. Fork tests kept. | |
| #96 Slack Agent-experience vs bot manifests | Re-ported into `setup-shared.ts` (`SlackManifestMode`, mode-gated `agent_view`/scopes/events, display-name normalization) and `setup-core.ts` (mode prompt in the bot branch; quickstart keeps the bot manifest). Thread-target handling for Agent DM roots is upstream (`threading.ts`). | |
| #97 acpx shrinkwrap drift | Upstream removed npm-shrinkwrap generation entirely (`scripts/generate-npm-shrinkwrap.mjs` and all `npm-shrinkwrap.json`). Followed upstream. | |
| #98/#103 Claude Code bridge runtime | Fork-only files merged clean; `package.json` `files` + `bridge:install` script re-added. | `extensions/claude-code-bridge/`, `scripts/install-claude-code-bridge.mjs` |
| #100 cron delivery truth | Upstream redesigned cron delivery around `deliveryState`/`recordDelivery`. Re-ported as: `blocked-by-policy` classification of hook-cancelled sends (`delivery-dispatch.ts`, `resolvePolicyBlockedSendReason` kept), `deliveryFailedError` on `CronResolvedDeliveryState` for unconfirmed best-effort sends, error-streak counting in `service/timer-outcomes.ts`, `completion-status.ts` treats policy blocks as terminal non-failures. `run-log.ts`, `run-log/entry-codec.ts`, `service/ops.ts` were deleted upstream (statuses flow through `deliveryState`). `delivery-dispatch.policy-block.test.ts` re-cut to the pure classifier; job-state truth asserted in `service.persists-delivered-status.test.ts` with injected `deliveryState`. | |
| #101 multi-person DMs open before send | Re-ported in `extensions/slack/src/send.ts` (MPIM recipients resolve via `conversations.open`). | |
| #104 private browser screenshots | Already upstream (`browser-tool.screenshot.ts`, `screenshot-sharing.ts`). Fork change dropped. | |
| #105 clear recovered git-identity failures (codex) | Upstream removed the projector's fingerprint mechanism. Re-ported into `event-projector-tool-progress.ts` (`actionFingerprint` on `ToolErrorSummary`, recovery match via `native-command-recovery.ts`); test re-cut into `event-projector.native-failures.test.ts`. | |
| #106 customer-harness impact gate | Fork-only (`.github/scripts/`, workflows) merged clean. | |
| #107 blocked tool-only turns | Re-ported into `run/incomplete-turn-resolution.ts` (no `lastToolError` exemption); focused test in `run.incomplete-turn.classification.test.ts`. | |
| #108 approval wait inside the turn-idle budget | `src/infra/plugin-approvals.ts` merged clean; the clamp re-ported into `agent-tools.before-tool-call.approval.ts` (upstream split). | |
| #109 Slack outbound delivery log | Merged clean (`message-sent-hook.ts`). | |
| instanceId (cross-Ari memory) | Root `instanceId` re-homed into `zod-schema.root-shape.ts`; memory-wiki default vault `~/.openclaw/wiki/{instanceId}`; health summary `instanceId` in `src/gateway/health/{collector,types}.ts` (`commands/health.types.ts` deleted upstream). | |
| agent aliases / persona-label ids | `aliases` on `AgentEntrySchema`; `canonicalizeAgentId` + alias fallback in `agent-scope-config.ts`; CLI override resolution moved to `src/agents/command/prepare.ts`. | |
| `context` note on gateway `send` | Re-ported (`schema/agent.ts`, `server-methods/send.ts`, Swift regen pending). | |
| Workflow guards (`if: github.repository == 'openclaw/openclaw'`) | Re-applied to auto-response, real-behavior-proof, labeler, opengrep-precise. `ensure-base-commit` is now a Python owner script upstream; the fork's 240 s fetch timeout has no equivalent knob. | |

## Upstream mechanisms that replaced fork files (deletions accepted)

`src/cron/run-log.ts`, `src/cron/run-log/entry-codec.ts`, `src/cron/service/ops.ts`,
`src/gateway/server-methods/sessions.ts`, `src/commands/health.types.ts`,
`packages/gateway-protocol/src/schema/types.ts`, `extensions/memory-wiki/src/memory-palace.ts`,
`extensions/slack/src/actions.runtime.ts`, `src/agents/embedded-agent-runner/run/incomplete-turn.ts`,
`scripts/plugin-sdk-surface-report.mjs`, `docs/.generated/plugin-sdk-api-baseline.sha256`,
`scripts/generate-npm-shrinkwrap.mjs`, every `npm-shrinkwrap.json`, the dreaming UI
controllers, `src/agents/cli-output.test.ts`, `run.incomplete-turn.test.ts`,
`extensions/codex/src/app-server/event-projector.test.ts` (tests re-cut, see above).

## ui/

Per the PR A seat: fork main's #94–#109 touched exactly one `ui/` file (`ui/package.json`),
so `ui/` is upstream 9.2 wholesale. #112 branding is cherry-picked on top (`9d60c7e0`) as a
separate commit so #123 can `git rebase --onto <head> 0f05fcb0`.

## Follow-ups (explicitly not done here)

- Regenerate protocol clients (`pnpm protocol:gen`, `protocol:gen:swift`, `protocol:gen:kotlin`)
  for `context`, `reasoningLevel`, `cloudAuth`, and local-seat — done on Prime as a
  separate commit if the check fails.
- The cloud-brain bridge (#82) must be smoke-tested on a Vault box before a release cut.
- `src/commands/agent.runtime-config.test.ts` is upstream's; the fork's reranker-target
  test is replaced by `command-secret-targets.test.ts` + `runtime-provider-and-media-surfaces.test.ts`.
- #110/#114/#115/#116–#120 retarget onto this head (backlog seat).
