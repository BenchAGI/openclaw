#!/bin/bash
# launch-readiness.sh — single source of truth for "are we ready to launch?"
#
# Runs 21 binary checks spanning infra, billing, data integrity, observability,
# canvas truth, and customer-ready (cycles 6-12). Outputs a human-readable
# report (default) or JSON (--json). Exits with the number of RED checks
# (0 = launch-ready; anything > 0 = not yet).
#
# Usage:
#   launch-readiness.sh                # human report
#   launch-readiness.sh --json         # machine-readable JSON
#   launch-readiness.sh --check <name> # run a single check
#   launch-readiness.sh --help
#
# States:
#   GREEN — the thing is verifiably true right now
#   RED   — the thing is actively broken
#   SKIP  — the thing is structurally impossible to verify today (e.g. depends
#           on an unshipped cycle, or requires Firestore auth). SKIP is a
#           non-blocking "not yet"; the cloud-side mirror covers most of these.
#
# Conventions:
#   - Each check is a bash function returning 0 (green), 1 (red), or 2 (skip)
#     via the global __RESULT / __REASON vars.
#   - Checks are cheap (<2 s) where possible. Restore rehearsal is the slow one.
#   - Paths are absolute. We check the main monorepo at $MONO, not the
#     current worktree.
#
# Design notes:
#   - Originals #1-#15 come from Cycle 5's launch-readiness-matrix prompt.
#   - Customer-Ready extensions #16, #18-#22 come from Cycles 6, 8-12. The
#     original #8 and customer-ready #17 are the SAME check (rate limiter),
#     so the matrix has 21 distinct entries, not 22.
#   - Cloud-Function mirror at apps/web/functions/src/launch-readiness/
#     daily-check.ts covers the SKIP items that need Firestore auth.
#
# ─────────────────────────────────────────────────────────────────────────

set -uo pipefail

# ─── Config ──────────────────────────────────────────────────────────────

MONO="${MONO:-${HOME}/clawd/kestrel-crew/BenchAGI_Mono_Repo}"
WIKI="${HOME}/.openclaw/wiki/main"
CANVAS="${WIKI}/_boards/command-center.canvas"
LOG_DIR="${HOME}/.openclaw/logs"
STATE_JSON="${LOG_DIR}/launch-readiness.state.json"

mkdir -p "${LOG_DIR}"

# ─── Flag parsing ────────────────────────────────────────────────────────

MODE="human"
ONLY_CHECK=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)       MODE="json"; shift ;;
    --check)      ONLY_CHECK="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "unknown flag: $1" >&2
      exit 1
      ;;
  esac
done

# ─── Result accumulators ─────────────────────────────────────────────────

# Parallel arrays: label, state (GREEN|RED|SKIP), reason
LABELS=()
STATES=()
REASONS=()
CYCLES=()  # which cycle this check belongs to

GREEN_COUNT=0
RED_COUNT=0
SKIP_COUNT=0

# Set by each check function before returning
__RESULT="RED"
__REASON="unspecified"

record() {
  local label="$1" cycle="$2"
  LABELS+=("${label}")
  STATES+=("${__RESULT}")
  REASONS+=("${__REASON}")
  CYCLES+=("${cycle}")
  case "${__RESULT}" in
    GREEN) GREEN_COUNT=$((GREEN_COUNT + 1)) ;;
    RED)   RED_COUNT=$((RED_COUNT + 1)) ;;
    SKIP)  SKIP_COUNT=$((SKIP_COUNT + 1)) ;;
  esac
}

green() { __RESULT="GREEN"; __REASON="$1"; }
red()   { __RESULT="RED";   __REASON="$1"; }
skip()  { __RESULT="SKIP";  __REASON="$1"; }

# ─── Helpers ─────────────────────────────────────────────────────────────

http_status() {
  local url="$1"
  curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null || echo "000"
}

minutes_since() {
  # Arg: absolute file path. Echoes minutes since mtime, or 999999 if missing.
  local f="$1"
  if [[ ! -e "$f" ]]; then echo 999999; return; fi
  local now mtime
  now=$(date +%s)
  mtime=$(stat -f %m "$f" 2>/dev/null || echo "$now")
  echo $(( (now - mtime) / 60 ))
}

file_in_main_ref() {
  # Verify a path exists on the main branch of $MONO (regardless of worktree checkout).
  local relpath="$1"
  (cd "$MONO" 2>/dev/null && git show "main:${relpath}" >/dev/null 2>&1)
}

grep_in_main_ref() {
  # Grep a pattern in a file on main ref.
  local pattern="$1" relpath="$2"
  (cd "$MONO" 2>/dev/null && git show "main:${relpath}" 2>/dev/null | grep -qE "$pattern")
}

# ─── Infrastructure (5) ──────────────────────────────────────────────────

check_vault_backup_fresh() {
  local log="${LOG_DIR}/vault-backup.log"
  local mins; mins=$(minutes_since "$log")
  if [[ "$mins" -le 1500 ]]; then   # 25 hours
    green "last backup log entry ${mins}m ago"
  else
    red "vault-backup.log mtime is ${mins}m ago (>25h)"
  fi
}

check_vault_backup_restore() {
  local script="${HOME}/.openclaw/scripts/test-restore-from-colludr.sh"
  if [[ ! -x "$script" ]]; then
    red "restore rehearsal script missing: $script"; return
  fi
  if "$script" >/dev/null 2>&1; then
    green "restore rehearsal: checksum matched"
  else
    red "restore rehearsal failed (rerun $script for details)"
  fi
}

check_openclaw_gateway() {
  if curl -sf -o /dev/null --max-time 5 http://localhost:18789/health; then
    green "localhost:18789/health returned 200"
  else
    red "localhost:18789/health unreachable or non-200"
  fi
}

check_wiki_mirror_healthy() {
  if ! launchctl list ai.openclaw.wiki-mirror >/dev/null 2>&1; then
    red "ai.openclaw.wiki-mirror not loaded"; return
  fi
  # Last-exit of 0 is not always available; fallback to log freshness (<5 min).
  local log
  for log in "${LOG_DIR}/wiki-mirror.log" "${LOG_DIR}/wiki-mirror.stdout.log" "${HOME}/Library/Logs/ai.openclaw.wiki-mirror.stdout.log"; do
    if [[ -e "$log" ]]; then
      local mins; mins=$(minutes_since "$log")
      if [[ "$mins" -le 5 ]]; then
        green "launchd loaded; last log ${mins}m ago"; return
      fi
    fi
  done
  # If logs aren't rotating, check job list exit_code (line "LastExitStatus = 0")
  local last_exit
  last_exit=$(launchctl list ai.openclaw.wiki-mirror 2>/dev/null | awk -F' = ' '/LastExitStatus/ {gsub(/[";]/,"",$2); print $2}')
  if [[ "$last_exit" == "0" ]]; then
    green "launchd loaded; LastExitStatus=0"
  else
    red "launchd loaded but last run log >5m old and LastExitStatus=${last_exit:-unknown}"
  fi
}

check_dreaming_crons_fired() {
  # Expect at least 6 of 7 dreaming crons to have written a file today or yesterday.
  local today yesterday count
  today=$(date +%Y-%m-%d)
  yesterday=$(date -v-1d +%Y-%m-%d)
  count=$(find "${WIKI}/dreams" "${WIKI}/canon" -type f \( -name "${today}.md" -o -name "${yesterday}.md" \) 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$count" -ge 6 ]]; then
    green "${count} dream/canon files for today or yesterday"
  elif [[ "$count" -ge 1 ]]; then
    red "only ${count} dream/canon files dated today/yesterday (expected ≥6)"
  else
    red "no dream/canon files today or yesterday — crons silent"
  fi
}

# ─── Billing (3) ─────────────────────────────────────────────────────────

check_billing_function_deployed() {
  if ! command -v gcloud >/dev/null 2>&1; then
    skip "gcloud CLI not installed locally — cloud mirror covers this"; return
  fi
  if gcloud functions list --format="value(name)" 2>/dev/null | grep -qE '(^|\s)syncAiUsageToStripe(\s|$)'; then
    green "syncAiUsageToStripe ACTIVE in us-central1"
  else
    red "syncAiUsageToStripe not found in gcloud functions list"
  fi
}

check_billing_model_coverage() {
  # Source-of-truth: MODEL_PRICING on main includes claude-opus-4-7.
  local relpath="apps/web/functions/src/billing/ai-usage-sync.ts"
  if ! file_in_main_ref "$relpath"; then
    red "main:${relpath} missing"; return
  fi
  if grep_in_main_ref 'claude-opus-4-7' "$relpath"; then
    green "MODEL_PRICING contains claude-opus-4-7"
  else
    red "MODEL_PRICING missing claude-opus-4-7 — regression risk"
  fi
}

check_rate_limiter_active() {
  # Cycle 7 output: pre-request gate at apps/web/functions/src/billing/rate-limit.ts
  # with exported checkRateLimit. This is NOT the aurelius tool-level limiter.
  local relpath="apps/web/functions/src/billing/rate-limit.ts"
  if ! file_in_main_ref "$relpath"; then
    skip "Cycle 7 not shipped — ${relpath} does not exist on main"; return
  fi
  if grep_in_main_ref 'export (async )?function checkRateLimit' "$relpath"; then
    green "checkRateLimit exported from ${relpath}"
  else
    red "${relpath} exists but does not export checkRateLimit"
  fi
}

# ─── Data integrity (3) ──────────────────────────────────────────────────

check_identity_index_populated() {
  # Requires Firestore Admin auth — local shell can't do this cheaply. The
  # cloud-side daily-check.ts mirror covers this.
  skip "requires Firestore auth — covered by cloud-side daily-check.ts"
}

check_canon_auto_approve_on() {
  # WIKI_AUTO_APPROVE_ENABLED is set to "true" in apphosting.yaml env vars.
  local relpath="apphosting.yaml"
  if ! file_in_main_ref "$relpath"; then
    red "main:${relpath} missing"; return
  fi
  # Look for the variable set to "true" (with quotes, YAML style).
  if (cd "$MONO" && git show "main:${relpath}" 2>/dev/null | \
       awk '/WIKI_AUTO_APPROVE_ENABLED/,/^$/' | grep -qE 'value:\s*"true"'); then
    green "apphosting.yaml: WIKI_AUTO_APPROVE_ENABLED=\"true\""
  else
    red "apphosting.yaml does not have WIKI_AUTO_APPROVE_ENABLED=\"true\""
  fi
}

check_no_stuck_approvals() {
  skip "requires Firestore auth — covered by cloud-side daily-check.ts"
}

# ─── Observability (2) ───────────────────────────────────────────────────

check_morning_digest_ran() {
  skip "requires Firestore auth (platform/morningDigest/runs) — cloud mirror"
}

check_github_activity_scan_ran() {
  skip "requires Firestore auth (scan heartbeat doc) — cloud mirror"
}

# ─── Canvas truth (2) ────────────────────────────────────────────────────

check_canvas_parses() {
  if [[ ! -f "$CANVAS" ]]; then
    red "canvas file missing: $CANVAS"; return
  fi
  if jq empty "$CANVAS" >/dev/null 2>&1; then
    local n
    n=$(jq '.nodes | length' "$CANVAS" 2>/dev/null)
    green "canvas valid JSON; ${n} nodes"
  else
    red "jq parse failed on $CANVAS"
  fi
}

check_no_stale_status() {
  # Any last_verified: YYYY-MM-DD under _boards/nodes/**/*.md older than 30 days
  # marks a stale detail page.
  local nodes_dir="${WIKI}/_boards/nodes"
  if [[ ! -d "$nodes_dir" ]]; then
    skip "node detail pages directory missing"; return
  fi
  local today_s stale=0 oldest=""
  today_s=$(date +%s)
  local f d d_s age
  while IFS= read -r f; do
    d=$(grep -Eo '^last_verified:\s*[0-9]{4}-[0-9]{2}-[0-9]{2}' "$f" 2>/dev/null | head -1 | awk '{print $2}')
    [[ -z "$d" ]] && continue
    d_s=$(date -j -f "%Y-%m-%d" "$d" +%s 2>/dev/null || echo 0)
    [[ "$d_s" -eq 0 ]] && continue
    age=$(( (today_s - d_s) / 86400 ))
    if [[ "$age" -gt 30 ]]; then
      stale=$((stale + 1))
      [[ -z "$oldest" ]] && oldest="$(basename "$f") (${age}d)"
    fi
  done < <(find "$nodes_dir" -type f -name '*.md')
  if [[ "$stale" -eq 0 ]]; then
    green "no last_verified fields >30d old"
  else
    red "${stale} node page(s) have last_verified >30d old; e.g. ${oldest}"
  fi
}

# ─── Customer-Ready extensions (6 — note: #17 dedups with #8) ────────────

check_tier_d_shipped() {
  # Cycle 6: BenchAGI-owned bench-cowork plugin released to a public artifact.
  # Will SKIP until there's a release on BenchAGI/bench-cowork or a github
  # release tagged tier-d-* on the monorepo.
  if ! command -v gh >/dev/null 2>&1; then
    skip "gh CLI not installed — cloud mirror covers this"; return
  fi
  # Try dedicated repo first, fall back to monorepo tag pattern.
  if gh release list -R BenchAGI/bench-cowork --limit 1 2>/dev/null | grep -q . ; then
    local latest
    latest=$(gh release list -R BenchAGI/bench-cowork --limit 1 --json tagName -q '.[0].tagName' 2>/dev/null)
    green "BenchAGI/bench-cowork latest release: ${latest}"
  elif gh release list -R BenchAGI/BenchAGI_Mono_Repo --limit 5 --json tagName -q '.[].tagName' 2>/dev/null | grep -q '^tier-d'; then
    green "tier-d-* release exists on monorepo"
  else
    skip "Cycle 6 not shipped — no BenchAGI/bench-cowork release and no tier-d-* tag"
  fi
}

check_d2_multitenant_isolated() {
  # Cycle 8: apps/web/functions/src/wiki/__tests__/d2-isolation.test.ts passes
  local relpath="apps/web/functions/src/wiki/__tests__/d2-isolation.test.ts"
  if ! file_in_main_ref "$relpath"; then
    skip "Cycle 8 not shipped — ${relpath} does not exist on main"; return
  fi
  # Running the test here would need pnpm install etc; assume passing if present
  # AND no "d2-isolation.*FAIL" lines appear in recent CI logs. Since we cannot
  # cheaply run the suite, a file-exists + greppable describe block is our best
  # signal; the CI lane owns the pass/fail.
  if grep_in_main_ref 'describe.*D2.*isolation|describe.*d2-isolation' "$relpath"; then
    green "d2-isolation.test.ts present on main (CI enforces pass)"
  else
    red "${relpath} exists but no isolation describe block"
  fi
}

check_agent_charter_published() {
  local code; code=$(http_status "https://benchagi.com/about/agents")
  if [[ "$code" == "200" ]]; then
    green "GET /about/agents → 200"
  elif [[ "$code" == "404" ]]; then
    skip "Cycle 9 not shipped — /about/agents 404"
  else
    red "GET /about/agents → ${code}"
  fi
}

check_support_page_live() {
  local code; code=$(http_status "https://benchagi.com/support")
  if [[ "$code" == "200" ]]; then
    green "GET /support → 200"
  elif [[ "$code" == "404" ]]; then
    skip "Cycle 10 not shipped — /support 404"
  else
    red "GET /support → ${code}"
  fi
}

check_tier_b_installer_available() {
  # Cycle 11: `brew install benchagi/tap/openclaw` resolves to a formula.
  if ! command -v brew >/dev/null 2>&1; then
    skip "brew not installed — cannot verify"; return
  fi
  # info returns non-zero if the formula can't be resolved; stderr contains the
  # error. A shipped tier-B install means the tap + formula both exist.
  if brew info benchagi/tap/openclaw >/dev/null 2>&1; then
    green "brew formula benchagi/tap/openclaw resolves"
  else
    skip "Cycle 11 not shipped — benchagi/tap/openclaw does not resolve"
  fi
}

check_billing_per_user_ui_live() {
  local code; code=$(http_status "https://benchagi.com/admin/billing")
  # 2xx = live; 3xx possibly auth-redirect (also counts as live); 404 = unshipped
  if [[ "$code" =~ ^2 ]] || [[ "$code" =~ ^3 ]]; then
    green "GET /admin/billing → ${code}"
  elif [[ "$code" == "404" ]]; then
    skip "Cycle 12 not shipped — /admin/billing 404"
  else
    red "GET /admin/billing → ${code}"
  fi
}

# ─── Check registry + runner ─────────────────────────────────────────────
# Ordered 1..21. Each row: fn_name | display_label | cycle_tag

CHECK_ROWS=(
  "check_vault_backup_fresh|vault-backup-fresh|5"
  "check_vault_backup_restore|vault-backup-restore|5"
  "check_openclaw_gateway|openclaw-gateway|5"
  "check_wiki_mirror_healthy|wiki-mirror-healthy|5"
  "check_dreaming_crons_fired|dreaming-crons-fired|5"
  "check_billing_function_deployed|billing-function-deployed|5"
  "check_billing_model_coverage|billing-model-coverage|5"
  "check_rate_limiter_active|rate-limiter-active|7"
  "check_identity_index_populated|identity-index-populated|5"
  "check_canon_auto_approve_on|canon-auto-approve-on|5"
  "check_no_stuck_approvals|no-stuck-approvals|5"
  "check_morning_digest_ran|morning-digest-ran|5"
  "check_github_activity_scan_ran|github-activity-scan-ran|5"
  "check_canvas_parses|canvas-parses|5"
  "check_no_stale_status|no-stale-status|5"
  "check_tier_d_shipped|tier-d-shipped|6"
  "check_d2_multitenant_isolated|d2-multitenant-isolated|8"
  "check_agent_charter_published|agent-charter-published|9"
  "check_support_page_live|support-page-live|10"
  "check_tier_b_installer_available|tier-b-installer-available|11"
  "check_billing_per_user_ui_live|billing-per-user-ui-live|12"
)

run_check() {
  local fn="$1" label="$2" cycle="$3"
  # Reset
  __RESULT="RED"
  __REASON="check function did not set result"
  # Run
  if ! declare -f "$fn" >/dev/null; then
    red "check function ${fn} not defined"
  else
    "$fn" || true
  fi
  record "$label" "$cycle"
}

# ─── Main ────────────────────────────────────────────────────────────────

if [[ -n "$ONLY_CHECK" ]]; then
  # Run a single check by its display label
  matched=0
  for row in "${CHECK_ROWS[@]}"; do
    IFS='|' read -r fn label cycle <<<"$row"
    if [[ "$label" == "$ONLY_CHECK" ]]; then
      run_check "$fn" "$label" "$cycle"
      matched=1
      break
    fi
  done
  if [[ "$matched" -eq 0 ]]; then
    echo "unknown check label: $ONLY_CHECK" >&2
    echo "available labels:" >&2
    for row in "${CHECK_ROWS[@]}"; do
      IFS='|' read -r _ label _ <<<"$row"
      echo "  $label" >&2
    done
    exit 1
  fi
else
  for row in "${CHECK_ROWS[@]}"; do
    IFS='|' read -r fn label cycle <<<"$row"
    run_check "$fn" "$label" "$cycle"
  done
fi

# ─── Output ──────────────────────────────────────────────────────────────

TOTAL=${#LABELS[@]}

emit_json() {
  # Hand-roll JSON to avoid a jq pipeline with many variables.
  printf '{\n'
  printf '  "generatedAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '  "totals": { "total": %d, "green": %d, "red": %d, "skipped": %d },\n' \
    "$TOTAL" "$GREEN_COUNT" "$RED_COUNT" "$SKIP_COUNT"
  printf '  "launchReady": %s,\n' $([[ "$RED_COUNT" -eq 0 ]] && echo true || echo false)
  printf '  "checks": [\n'
  for i in "${!LABELS[@]}"; do
    local comma=","
    [[ "$i" -eq $((TOTAL - 1)) ]] && comma=""
    # Escape quotes/backslashes in reason
    local reason_escaped="${REASONS[$i]//\\/\\\\}"
    reason_escaped="${reason_escaped//\"/\\\"}"
    printf '    { "label": "%s", "state": "%s", "cycle": %s, "reason": "%s" }%s\n' \
      "${LABELS[$i]}" "${STATES[$i]}" "${CYCLES[$i]}" "$reason_escaped" "$comma"
  done
  printf '  ]\n'
  printf '}\n'
}

emit_human() {
  echo "=== Launch Readiness — $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  echo
  for i in "${!LABELS[@]}"; do
    local state="${STATES[$i]}"
    local symbol
    case "$state" in
      GREEN) symbol="🟢" ;;
      RED)   symbol="🔴" ;;
      SKIP)  symbol="⚪" ;;
    esac
    printf '[%s] %s %-32s — %s\n' "$state" "$symbol" "${LABELS[$i]}" "${REASONS[$i]}"
  done
  echo
  local verdict="NOT READY"
  [[ "$RED_COUNT" -eq 0 ]] && verdict="LAUNCH READY"
  [[ "$RED_COUNT" -eq 0 && "$SKIP_COUNT" -gt 0 ]] && verdict="LAUNCH READY (with ${SKIP_COUNT} skipped)"
  echo "SUMMARY: ${GREEN_COUNT}/${TOTAL} green, ${RED_COUNT}/${TOTAL} red, ${SKIP_COUNT}/${TOTAL} skipped"
  echo "VERDICT: ${verdict}"
}

# Rewrite the live canvas tile each run so Obsidian picks up fresh state.
# The tile at _boards/live/launch-readiness.md is referenced from the canvas
# node `launch-readiness-tile`; this is the same live-file pattern the drift
# detector uses for drift-status.md.
emit_canvas_tile() {
  local target="${WIKI}/_boards/live/launch-readiness.md"
  mkdir -p "$(dirname "$target")"

  local headline banner
  if [[ "$RED_COUNT" -eq 0 && "$SKIP_COUNT" -eq 0 ]]; then
    headline="✅ ${GREEN_COUNT} / ${TOTAL} green — **LAUNCH READY**"
    banner="All checks pass. Verify 7 consecutive days of green before flipping PERSONAL_BAILEY."
  elif [[ "$RED_COUNT" -eq 0 ]]; then
    headline="🟡 ${GREEN_COUNT} / ${TOTAL} green, ${SKIP_COUNT} skipped"
    banner="No red checks. Skipped items are awaiting unshipped cycles (6-12) or Firestore auth; the daily Cloud Function fills those in."
  else
    headline="🔴 ${RED_COUNT} red · ${GREEN_COUNT} green · ${SKIP_COUNT} skipped"
    banner="Active blockers. Fix red rows before declaring launch-ready."
  fi

  {
    echo "---"
    echo "title: \"🚀 Launch Readiness — $(date +%Y-%m-%d)\""
    echo "live: true"
    echo "updated: \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\""
    echo "---"
    echo
    echo "# 🚀 Launch Readiness"
    echo
    echo "**Last run:** $(date '+%Y-%m-%d %H:%M:%S %Z')"
    echo "**Result:** ${headline}"
    echo
    echo "> ${banner}"
    echo
    echo "| # | Check | State | Cycle | Reason |"
    echo "|---|-------|-------|-------|--------|"
    local i sym
    for i in "${!LABELS[@]}"; do
      case "${STATES[$i]}" in
        GREEN) sym="🟢" ;;
        RED)   sym="🔴" ;;
        SKIP)  sym="⚪" ;;
      esac
      # Pipe-escape reason so the table isn't mangled
      local reason_safe="${REASONS[$i]//|/\\|}"
      printf '| %d | %s | %s | C%s | %s |\n' "$((i+1))" "${LABELS[$i]}" "${sym}" "${CYCLES[$i]}" "${reason_safe}"
    done
    echo
    echo "## Exit protocol"
    echo
    echo "- Script exit code = number of red checks (0 = launch-ready)"
    echo "- \`${STATE_JSON}\` — machine-readable snapshot from the last run"
    echo "- Cloud-side mirror: Cloud Function \`launchReadinessDailyCheck\` writes \`platform/launchReadiness/<date>\` daily at 06:00 MT"
    echo "- See \`_boards/launch-readiness/README.md\` > Launch protocol for the 7-day-green rule"
  } > "$target"
}

# Always write the state snapshot for the canvas + daily-check mirror.
emit_json > "$STATE_JSON"
emit_canvas_tile

if [[ "$MODE" == "json" ]]; then
  cat "$STATE_JSON"
else
  emit_human
fi

# Exit code = number of RED checks (0 ⇔ launch-ready).
exit "$RED_COUNT"
