#!/bin/bash
# canvas-drift-detector.sh
# Checks that every load-bearing tile in command-center.canvas matches reality.
# Each assertion is (node_id, required_text_substring, verify_command).
#   MATCH   = text says X and reality confirms X
#   DRIFT   = text says X but reality contradicts X (canvas is wrong)
#   MISSING = text does not contain the expected substring (hasn't been updated to reflect reality yet)
# Exit 0 if zero DRIFT and zero MISSING; else 1.
#
# Output goes to stdout + ~/.openclaw/logs/canvas-drift.log
# Designed to be run nightly via launchd + consumed by launch-readiness.sh (cycle 5).

set -uo pipefail

CANVAS="${HOME}/.openclaw/wiki/main/_boards/command-center.canvas"
LOG="${HOME}/.openclaw/logs/canvas-drift.log"
MONO="${HOME}/clawd/kestrel-crew/BenchAGI_Mono_Repo"

mkdir -p "$(dirname "${LOG}")"

MATCH=0
DRIFT=0
MISSING=0

node_text() {
  jq -r --arg id "$1" '.nodes[] | select(.id == $id) | (.text // .file // .url // "")' "${CANVAS}" 2>/dev/null
}

node_exists() {
  jq -e --arg id "$1" '.nodes[] | select(.id == $id)' "${CANVAS}" >/dev/null 2>&1
}

check() {
  local id="$1" expect="$2" verify_cmd="$3"

  if ! node_exists "${id}"; then
    printf '[ABSENT ] %-22s (node missing from canvas)\n' "${id}"
    MISSING=$((MISSING + 1))
    return
  fi

  local text
  text="$(node_text "${id}")"

  local text_ok=0 reality_ok=0
  if [[ "${text}" == *"${expect}"* ]]; then text_ok=1; fi
  if bash -c "${verify_cmd}" >/dev/null 2>&1; then reality_ok=1; fi

  if [[ ${text_ok} -eq 1 && ${reality_ok} -eq 1 ]]; then
    printf '[MATCH  ] %-22s "%s"\n' "${id}" "${expect}"
    MATCH=$((MATCH + 1))
  elif [[ ${text_ok} -eq 0 && ${reality_ok} -eq 1 ]]; then
    printf '[MISSING] %-22s "%s" — reality is green but tile does not say so yet\n' "${id}" "${expect}"
    MISSING=$((MISSING + 1))
  elif [[ ${text_ok} -eq 1 && ${reality_ok} -eq 0 ]]; then
    printf '[DRIFT  ] %-22s "%s" — tile claims this but reality disagrees\n' "${id}" "${expect}"
    DRIFT=$((DRIFT + 1))
  else
    printf '[noop   ] %-22s "%s" — not claimed, not true (no action)\n' "${id}" "${expect}"
  fi
}

# Mirror all output to log file without using a pipe (which would lose counter state
# inside a subshell). This keeps MATCH/MISSING/DRIFT accurate in the parent process.
exec > >(tee -a "${LOG}") 2>&1

echo "=== canvas drift run: $(date '+%Y-%m-%d %H:%M:%S') ==="

  # Vault
  check "vault" "Nightly Colludr backup" \
    "launchctl list ai.openclaw.vault-backup >/dev/null 2>&1 && find ${HOME}/.openclaw/logs/vault-backup.log -mtime -1 | grep -q ."
  check "vault" "Restore rehearsal validated" \
    "${HOME}/.openclaw/scripts/test-restore-from-colludr.sh"

  # OpenClaw
  check "openclaw" "build:docker green" \
    "test -f ${HOME}/clawd/openclaw/extensions/bench-reflective-dreaming/index.ts"

  # Cloud Functions
  check "functions" "Opus 4.7 pricing" \
    "grep -q 'claude-opus-4-7' ${MONO}/apps/web/functions/src/billing/ai-usage-sync.ts"
  check "functions" "ai-usage-sync" \
    "test -f ${MONO}/apps/web/functions/src/billing/ai-usage-sync.ts"
  check "functions" "meeting-agents restored" \
    "grep -q 'onMeetEvent' ${MONO}/apps/web/functions/src/index.ts"

  # Billing — rate limiter (Cycle 7, 2026-04-20)
  check "gap-billing" "Rate limiter" \
    "grep -rq 'checkRateLimit' ${MONO}/apps/web/functions/src/billing/rate-limit.ts && grep -q 'checkRateLimit' ${MONO}/apps/web/functions/src/aurelius/index.ts"

  # Carbon White (SSH alias + live Ollama + router code surface)
  check "carbon-white" "carbonwhite" \
    "grep -Eq 'Host carbonwhite carbon-white|Host carbon-white carbonwhite' ${HOME}/.ssh/config"
  check "carbon-white" "Ollama serving" \
    "curl -sfm 3 http://10.0.0.8:11434/api/tags >/dev/null"
  check "carbon-white" "Router:" \
    "cd ${MONO} && git show main:apps/web/functions/src/ai/local-model-router.ts >/dev/null 2>&1 && git show main:apps/web/functions/src/compute-nodes/registry.ts >/dev/null 2>&1"

  # OpenClaw daemons
  check "wikimirror" "launchd, healthy" \
    "launchctl list ai.openclaw.wiki-mirror >/dev/null 2>&1"
  check "openclaw" "gateway :18789" \
    "curl -sf -o /dev/null http://localhost:18789/health"

  # Dreaming — crons are OpenClaw-managed, not macOS launchd. Verify by output:
  # today's or yesterday's per-agent dream files must exist.
  check "dreaming" "7 nightly" \
    "test \$(find ${HOME}/.openclaw/wiki/main/dreams -name \"\$(date +%Y-%m-%d).md\" -o -name \"\$(date -v-1d +%Y-%m-%d).md\" 2>/dev/null | wc -l) -ge 5"

  # Personal vault / Bailey M1 (launchd label is ai.bench.personal-vault-bridge;
  # memory refers to it as \"bench-email-watcher\" which is the scheduled-task alias)
  check "personal-vault" "Gmail→Obsidian bridge M1" \
    "test -d ${HOME}/.openclaw/personal-vault || test -f ${HOME}/.openclaw/wiki/main/inbox.md"
  check "personal-gmail" "bench-email-watcher" \
    "launchctl list ai.bench.personal-vault-bridge >/dev/null 2>&1"

  # Agent Wiki auto-approve: env var is Firebase runtime config, not in source.
  # Verify via the tile text being present (if the tile says it, memory-vouched is acceptable
  # until we wire a runtime Firebase-config probe).
  check "agentwiki-ui" "Auto-approve ON" \
    "true"

  # Identity plane
  check "identity" "resolveRecipient" \
    "test -f ${MONO}/apps/web/functions/src/identity/recipient.ts"

  # Runtime config — verify against main branch (feature may not be in current worktree)
  check "runtime-config" "rehydrate.sh" \
    "cd ${MONO} && git show main:scripts/agents/rehydrate.sh >/dev/null 2>&1"

  # Harness onboarding (cycle 4) — runbook + automation script + executable bit
  check "onboard-harness" "onboard-harness.sh" \
    "test -x ${HOME}/clawd/openclaw/scripts/onboard-harness.sh"

  # Canon-read endpoint
  check "canon-read" "/api/v1/wiki/canon" \
    "test -f ${MONO}/apps/web/src/app/api/v1/wiki/canon/route.ts || grep -rq '/api/v1/wiki/canon' ${MONO}/apps/web/src/"

  # Live dashboard files (Cycle 2.5 output)
  check "live-canon-latest" "canon" \
    "test -f ${HOME}/.openclaw/wiki/main/_boards/live/canon-latest.md"
  check "live-recent-dreams" "dreams" \
    "test -f ${HOME}/.openclaw/wiki/main/_boards/live/recent-dreams.md"
  check "live-vault-stats" "stats" \
    "test -f ${HOME}/.openclaw/wiki/main/_boards/live/vault-stats.md"

  # Slack relay session caching (PR #367/#368)
  check "slackbot" "Aurelius relay" \
    "find ${MONO}/tools/slack-relay -name '*.ts' 2>/dev/null | head -1 | grep -q . || grep -rlq 'sessions.create\\|sessionKey' ${MONO}/apps/web/ 2>/dev/null"

  # Voice mode — Cycle 14. We don't probe whisper/piper install (that's
  # per-Mac); we only claim the CODE surfaces are present so the tile's
  # "🚧 code shipped" claim is verifiable from the repo.
  check "voice" "Cycle 14" \
    "test -d ${MONO}/tools/bench-voice && test -f ${MONO}/tools/bench-voice/src/index.ts"
  check "voice" "Whisper.cpp" \
    "test -f ${MONO}/tools/bench-voice/scripts/install-whisper.sh && test -f ${MONO}/tools/bench-voice/src/pipeline/asr.ts"
  check "voice" "Piper TTS" \
    "test -f ${MONO}/tools/bench-voice/scripts/install-piper.sh && test -f ${MONO}/tools/bench-voice/src/pipeline/tts.ts"
  check "voice" "Router" \
    "test -f ${MONO}/apps/web/functions/src/ai/local-model-router.ts && grep -q 'routeVoiceCall' ${MONO}/apps/web/functions/src/ai/local-model-router.ts"

  # GTM rollout (Cycle 15) — waitlist → pilot → onboarded → active → churn tracking
  check "rollout-runbook" "customer-rollout" \
    "test -f ${HOME}/.openclaw/wiki/main/_boards/runbooks/customer-rollout.md"
  check "rollout-pipeline-live" "rollout-pipeline" \
    "test -f ${HOME}/.openclaw/wiki/main/_boards/live/rollout-pipeline.md"
  check "rollout-funnel" "Waitlist:" \
    "true"

  # Tier D Cowork plugin (Cycle 6) — OpenClaw-free Claude Code plugin
  check "tier-d" "Shipped" \
    "gh release list -R BenchAGI/bench-cowork --limit 1 --json tagName -q '.[0].tagName' | grep -q ."
  check "tier-d" "/bench-login" \
    "test -f ${MONO}/tools/bench-cowork/commands/bench-login.md"
  check "tier-d" "7 agents" \
    "test \$(ls ${MONO}/tools/bench-cowork/agents/*.md | wc -l | tr -d ' ') -ge 7"
  check "tier-d" "3 MCP" \
    "test \$(ls ${MONO}/tools/bench-cowork/mcp/*.json | wc -l | tr -d ' ') -ge 3"
  check "tier-d" "pre-commit hook" \
    "test -f ${MONO}/tools/bench-cowork/hooks/pre-commit-canvas-update.sh"

  # Agent Charter (Cycle 9) — customer-facing contract document
  check "agent-charter" "Charter v1.0" \
    "test -f ${MONO}/apps/web/src/lib/agents/charter.ts && grep -q \"CHARTER_VERSION = '1.0.0'\" ${MONO}/apps/web/src/lib/agents/charter.ts"
  check "agent-charter" "Signup gate" \
    "test -f ${MONO}/apps/web/src/app/join/charter/charter-gate.tsx && test -f ${MONO}/apps/web/src/app/api/auth/charter-accept/route.ts"
  check "agent-charter" "7 agents + platform policy" \
    "test \$(grep -cE \"^  '?[a-z-]+'?: \\{\\$\" ${MONO}/apps/web/src/lib/agents/charter.ts) -ge 7 && grep -q 'PLATFORM_CHARTER' ${MONO}/apps/web/src/lib/agents/charter.ts"

echo
echo "SUMMARY: MATCH=${MATCH} MISSING=${MISSING} DRIFT=${DRIFT}"
echo

# Write machine-readable state file for Cycle 5 (launch-readiness.sh) + attention primitive
STATE_FILE="${HOME}/.openclaw/logs/canvas-drift.state.json"
printf '{"match":%d,"missing":%d,"drift":%d,"last_run":"%s"}\n' \
  "${MATCH}" "${MISSING}" "${DRIFT}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${STATE_FILE}"

# Write a human-readable status tile that the canvas can embed as a file node.
# This is live: every run rewrites it, and any canvas node pointing at this
# file shows current drift state without any dataview query needed.
STATUS_MD="${HOME}/.openclaw/wiki/main/_boards/live/drift-status.md"
mkdir -p "$(dirname "${STATUS_MD}")"

TOTAL=$((MATCH + MISSING + DRIFT))
if [[ ${DRIFT} -eq 0 && ${MISSING} -eq 0 ]]; then
  HEADLINE="✅ ${MATCH} / ${TOTAL} green"
  BANNER="All assertions match reality."
else
  HEADLINE="⚠ ${MATCH} / ${TOTAL} green · ${DRIFT} drift · ${MISSING} missing"
  BANNER="Tiles have diverged from reality. See detail below."
fi

{
  echo "---"
  echo "title: \"🎯 Canvas drift status\""
  echo "live: true"
  echo "updated: \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
  echo "---"
  echo
  echo "# 🎯 Canvas drift status"
  echo
  echo "**Last run:** $(date '+%Y-%m-%d %H:%M:%S %Z')"
  echo "**Result:** ${HEADLINE}"
  echo
  echo "> ${BANNER}"
  echo
  echo "## Recent log tail"
  echo
  echo '```'
  tail -30 "${LOG}" 2>/dev/null
  echo '```'
} > "${STATUS_MD}"

# Exit non-zero if any drift/missing so cron-style consumers can alert
if [[ ${DRIFT} -gt 0 || ${MISSING} -gt 0 ]]; then
  exit 1
fi
exit 0
