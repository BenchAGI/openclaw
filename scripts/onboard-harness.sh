#!/bin/bash
# onboard-harness.sh — idempotent harness onboarding for Tier A / B / C.
#
# Usage:
#   onboard-harness.sh --tier B --instance-id <id> [--backup-host <alias>] [--dry-run] [--root <dir>]
#
# Flags:
#   --tier A|B|C           tier to install (default B)
#   --instance-id <id>     instance id (required for A/B; ignored for C)
#   --backup-host <alias>  ssh alias for vault backups (default colludr)
#   --dry-run              print actions, no side effects
#   --root <dir>           override HOME (used for testing against /tmp/fake-harness-*)
#   -h | --help            this text
#
# Exit codes:
#   0 — success (or clean no-op on re-run)
#   1 — bad arguments / usage
#   2 — missing prerequisite (prints a clear message and the manual step needed)
#   3 — runtime failure inside an automated step

set -uo pipefail

# ─── Defaults ────────────────────────────────────────────────────────────
TIER="B"
INSTANCE_ID=""
BACKUP_HOST="colludr"
DRY_RUN=0
ROOT="${HOME}"

# Step accounting for the final report
STEPS_DONE=0
STEPS_SKIPPED=0
STEPS_MANUAL=0
STEPS_FAILED=0

# ─── Usage + arg parse ───────────────────────────────────────────────────
usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tier) TIER="${2:-}"; shift 2 ;;
    --instance-id) INSTANCE_ID="${2:-}"; shift 2 ;;
    --backup-host) BACKUP_HOST="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

case "${TIER}" in
  A|B|C) : ;;
  *) echo "--tier must be A, B, or C (got '${TIER}')" >&2; exit 1 ;;
esac

if [[ "${TIER}" != "C" && -z "${INSTANCE_ID}" ]]; then
  echo "--instance-id is required for tier ${TIER}" >&2
  exit 1
fi

# When running dry or with a custom root, never touch the real system
SAFE_MODE=0
if [[ ${DRY_RUN} -eq 1 || "${ROOT}" != "${HOME}" ]]; then
  SAFE_MODE=1
fi

# ─── Derived paths (honor --root) ────────────────────────────────────────
OC_DIR="${ROOT}/.openclaw"
OC_CONF="${OC_DIR}/openclaw.json"
OC_LOGS="${OC_DIR}/logs"
OC_SCRIPTS="${OC_DIR}/scripts"
OC_LAUNCHD_TEMPLATES="${OC_DIR}/launchd-templates"
WIKI_ROOT="${OC_DIR}/wiki"
LAUNCHAGENTS_DIR="${ROOT}/Library/LaunchAgents"
FORK_ROOT="${HOME}/clawd/openclaw"  # always the real clone; never rooted

# ─── Logging helpers ─────────────────────────────────────────────────────
now()    { date '+%Y-%m-%d %H:%M:%S'; }
info()   { printf '[%s] [info]   %s\n' "$(now)" "$*"; }
plan()   { printf '[%s] [plan]   %s\n' "$(now)" "$*"; }
done_()  { printf '[%s] [done]   step %d — %s\n' "$(now)" "$1" "$2"; STEPS_DONE=$((STEPS_DONE + 1)); }
skip()   { printf '[%s] [skip]   step %d — %s\n' "$(now)" "$1" "$2"; STEPS_SKIPPED=$((STEPS_SKIPPED + 1)); }
manual() { printf '[%s] [manual] step %d — %s\n' "$(now)" "$1" "$2"; STEPS_MANUAL=$((STEPS_MANUAL + 1)); }
fail()   { printf '[%s] [fail]   step %d — %s\n' "$(now)" "$1" "$2" >&2; STEPS_FAILED=$((STEPS_FAILED + 1)); }

run() {
  # Executes (or previews) a shell command. Respects DRY_RUN.
  if [[ ${DRY_RUN} -eq 1 ]]; then
    printf '[%s] [plan]   $ %s\n' "$(now)" "$*"
    return 0
  fi
  eval "$@"
}

require_cmd() {
  # require_cmd <name> <install hint>
  local cmd="$1" hint="${2:-(install and retry)}"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "prerequisite missing: ${cmd}" >&2
    echo "  fix: ${hint}" >&2
    exit 2
  fi
}

# ─── Banner ──────────────────────────────────────────────────────────────
info "onboard-harness.sh — tier ${TIER} — instance ${INSTANCE_ID:-<cloud>} — backup ${BACKUP_HOST}"
info "root=${ROOT}  dry-run=${DRY_RUN}  safe-mode=${SAFE_MODE}"
[[ ${DRY_RUN} -eq 1 ]] && info "dry-run: no side effects will happen."

# Tier C is mostly a stub — the runtime is cloud-hosted, no local install.
if [[ "${TIER}" == "C" ]]; then
  info "tier C (cloud-hosted): no local harness to install."
  info "next steps: provision the instance via BenchAGI admin console + link identity."
  manual 0 "Tier C provisioning happens in benchagi.com admin; no local work."
  info "summary: done=${STEPS_DONE} skipped=${STEPS_SKIPPED} manual=${STEPS_MANUAL} failed=${STEPS_FAILED}"
  exit 0
fi

# ─── Step 0: preflight ───────────────────────────────────────────────────
STEP=0
# In safe mode (dry-run or test root) we don't enforce brew/op availability —
# the purpose is to exercise the script's control flow, not the real system.
if [[ ${SAFE_MODE} -eq 0 ]]; then
  require_cmd brew   "https://brew.sh"
  require_cmd jq     "brew install jq"
  require_cmd op     "brew install --cask 1password-cli"
  require_cmd ssh    "comes with macOS; check PATH"
fi
if [[ ${DRY_RUN} -eq 1 ]]; then
  plan "mkdir -p ${OC_DIR} ${OC_LOGS} ${OC_SCRIPTS} ${OC_LAUNCHD_TEMPLATES} ${WIKI_ROOT} ${LAUNCHAGENTS_DIR}"
else
  mkdir -p "${OC_DIR}" "${OC_LOGS}" "${OC_SCRIPTS}" "${OC_LAUNCHD_TEMPLATES}" "${WIKI_ROOT}" "${LAUNCHAGENTS_DIR}"
fi
done_ "${STEP}" "preflight (tier=${TIER})"

# ─── Step 1: Install OpenClaw ────────────────────────────────────────────
STEP=1
if [[ ${SAFE_MODE} -eq 1 ]]; then
  # Simulate: write a version marker in the test root so re-runs can detect it.
  MARKER="${OC_DIR}/.openclaw-version"
  if [[ -f "${MARKER}" ]]; then
    skip "${STEP}" "openclaw already installed (safe-mode marker present)"
  else
    run "echo 'openclaw 2026.4.16 (safe-mode)' > '${MARKER}'"
    done_ "${STEP}" "openclaw installed (safe-mode marker written)"
  fi
else
  if command -v openclaw >/dev/null 2>&1; then
    skip "${STEP}" "openclaw already on PATH: $(openclaw --version 2>&1 | head -1)"
  else
    run "brew tap benchagi/openclaw 2>/dev/null || true"
    run "brew install openclaw || brew upgrade openclaw"
    if command -v openclaw >/dev/null 2>&1; then
      done_ "${STEP}" "openclaw installed"
    else
      fail "${STEP}" "openclaw install did not produce the 'openclaw' command"
      exit 3
    fi
  fi
fi

# ─── Step 2: Initialise config ──────────────────────────────────────────
STEP=2
if [[ -f "${OC_CONF}" ]] && (jq empty "${OC_CONF}" >/dev/null 2>&1 || [[ ${SAFE_MODE} -eq 1 ]]); then
  skip "${STEP}" "${OC_CONF} already exists"
else
  if [[ ${SAFE_MODE} -eq 1 ]]; then
    run "printf '{\"version\":\"safe-mode\",\"created\":\"%s\"}\\n' \"\$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > '${OC_CONF}'"
  else
    run "openclaw init --no-prompt"
  fi
  done_ "${STEP}" "config initialized at ${OC_CONF}"
fi

# ─── Step 3: Set instanceId ──────────────────────────────────────────────
STEP=3
CURRENT_ID=""
if [[ -f "${OC_CONF}" ]]; then
  CURRENT_ID="$(jq -r '.instanceId // ""' "${OC_CONF}" 2>/dev/null || echo "")"
fi
if [[ "${CURRENT_ID}" == "${INSTANCE_ID}" ]]; then
  skip "${STEP}" "instanceId already set to ${INSTANCE_ID}"
elif [[ -n "${CURRENT_ID}" && "${CURRENT_ID}" != "${INSTANCE_ID}" ]]; then
  fail "${STEP}" "instanceId collision: config has '${CURRENT_ID}', requested '${INSTANCE_ID}'. Refusing to overwrite."
  exit 3
else
  TMP_CONF="${OC_CONF}.onboard-tmp"
  run "jq --arg id '${INSTANCE_ID}' '.instanceId = \$id' '${OC_CONF}' > '${TMP_CONF}' && mv '${TMP_CONF}' '${OC_CONF}'"
  done_ "${STEP}" "instanceId set to ${INSTANCE_ID}"
fi

# ─── Step 4: Vault shard + main symlink ──────────────────────────────────
STEP=4
SHARD_DIR="${WIKI_ROOT}/${INSTANCE_ID}"
MAIN_LINK="${WIKI_ROOT}/main"
if [[ -d "${SHARD_DIR}" && -L "${MAIN_LINK}" && "$(readlink "${MAIN_LINK}")" == "${SHARD_DIR}" ]]; then
  skip "${STEP}" "vault shard + main symlink already exist"
else
  run "mkdir -p '${SHARD_DIR}'"
  # Only create/replace the symlink when it's missing or points elsewhere.
  if [[ -L "${MAIN_LINK}" ]]; then
    CUR_TARGET="$(readlink "${MAIN_LINK}")"
    if [[ "${CUR_TARGET}" != "${SHARD_DIR}" ]]; then
      fail "${STEP}" "~/.openclaw/wiki/main already points at '${CUR_TARGET}'. Remove it manually if you intend to repoint."
      exit 3
    fi
  elif [[ -e "${MAIN_LINK}" ]]; then
    fail "${STEP}" "~/.openclaw/wiki/main exists and is NOT a symlink; refusing to replace a real directory."
    exit 3
  else
    run "ln -sfn '${SHARD_DIR}' '${MAIN_LINK}'"
  fi
  done_ "${STEP}" "vault shard ${SHARD_DIR} + main symlink ready"
fi

# ─── Step 5: Canon seed [manual] ─────────────────────────────────────────
STEP=5
if [[ -f "${SHARD_DIR}/canon/topics/harness-tiers.md" ]]; then
  skip "${STEP}" "canon already seeded (harness-tiers.md present)"
else
  manual "${STEP}" "seed canon skeleton. Options:"
  manual "${STEP}" "  (a) rsync ${BACKUP_HOST}:bench-backups/wiki/latest/ ${SHARD_DIR}/"
  manual "${STEP}" "  (b) clone the BenchAGI monorepo and copy docs/wiki-skeleton/ into ${SHARD_DIR}/"
  info "continuing; canon-seed is not a hard blocker for steps 6-11."
fi

# ─── Step 6: Reflective-dreaming plugin ─────────────────────────────────
STEP=6
DREAM_EXT="${FORK_ROOT}/extensions/bench-reflective-dreaming"
CRON_MARK="${OC_DIR}/.dreaming-installed"
if [[ -f "${CRON_MARK}" ]]; then
  skip "${STEP}" "dreaming plugin already installed (marker present)"
elif [[ ${SAFE_MODE} -eq 1 ]]; then
  run "touch '${CRON_MARK}'"
  done_ "${STEP}" "dreaming plugin marker written (safe-mode)"
elif [[ ! -d "${DREAM_EXT}" ]]; then
  manual "${STEP}" "clone ~/clawd/openclaw first: git clone https://github.com/BenchAGI/openclaw.git ~/clawd/openclaw"
else
  run "(cd '${DREAM_EXT}' && node scripts/install.mjs)"
  run "touch '${CRON_MARK}'"
  done_ "${STEP}" "dreaming plugin installed + 7 nightly crons reconciled"
fi

# ─── Step 7: Gateway launchd plist ──────────────────────────────────────
STEP=7
GATEWAY_PLIST="${LAUNCHAGENTS_DIR}/ai.openclaw.gateway.plist"
GATEWAY_TEMPLATE="${OC_LAUNCHD_TEMPLATES}/ai.openclaw.gateway.plist"
if [[ -f "${GATEWAY_PLIST}" ]]; then
  skip "${STEP}" "gateway plist already at ${GATEWAY_PLIST}"
else
  # Write a starter plist if no template is staged yet (first-run case).
  if [[ ! -f "${GATEWAY_TEMPLATE}" ]]; then
    run "cat > '${GATEWAY_TEMPLATE}' <<'PLIST_EOF'
<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\"><dict>
<key>Label</key><string>ai.openclaw.gateway</string>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProgramArguments</key><array>
<string>/opt/homebrew/opt/node/bin/node</string>
<string>/opt/homebrew/lib/node_modules/openclaw/dist/entry.js</string>
<string>gateway</string><string>--port</string><string>18789</string>
</array>
</dict></plist>
PLIST_EOF"
  fi
  run "cp '${GATEWAY_TEMPLATE}' '${GATEWAY_PLIST}'"
  if [[ ${SAFE_MODE} -eq 0 ]]; then
    run "launchctl bootstrap gui/\$(id -u) '${GATEWAY_PLIST}' 2>/dev/null || launchctl load '${GATEWAY_PLIST}'"
  fi
  done_ "${STEP}" "gateway plist installed"
fi

# ─── Step 8: wiki-mirror plist [manual for API key] ─────────────────────
STEP=8
MIRROR_PLIST="${LAUNCHAGENTS_DIR}/ai.openclaw.wiki-mirror.plist"
if [[ -f "${MIRROR_PLIST}" ]]; then
  skip "${STEP}" "wiki-mirror plist already present"
else
  manual "${STEP}" "install wiki-mirror. Two steps required:"
  manual "${STEP}" "  (a) op item get 'Bench Wiki Ingest Key' --fields label=password  # requires Touch-ID"
  manual "${STEP}" "  (b) template the key into ~/.openclaw/launchd-templates/ai.openclaw.wiki-mirror.plist + cp + launchctl load"
fi

# ─── Step 9: vault backup to colludr [backup-host manual] ───────────────
STEP=9
BACKUP_SCRIPT="${OC_SCRIPTS}/backup-vault-to-${BACKUP_HOST}.sh"
BACKUP_PLIST="${LAUNCHAGENTS_DIR}/ai.openclaw.vault-backup.plist"
# Idempotency: in safe-mode the plist never lands, so gate on script presence alone.
#              in real-mode, require both to count as "wired up".
if [[ -f "${BACKUP_SCRIPT}" ]] && { [[ ${SAFE_MODE} -eq 1 ]] || [[ -f "${BACKUP_PLIST}" ]]; }; then
  skip "${STEP}" "vault backup already wired up"
else
  if [[ ${SAFE_MODE} -eq 0 ]]; then
    if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "${BACKUP_HOST}" true >/dev/null 2>&1; then
      manual "${STEP}" "ssh '${BACKUP_HOST}' fails BatchMode — add this Mac's pubkey to ${BACKUP_HOST}:~/.ssh/authorized_keys, then re-run"
    fi
  fi
  # Template the backup script by substituting HOST/USER in a reference copy.
  REF_BACKUP="${FORK_ROOT}/../../.openclaw/scripts/backup-vault-to-colludr.sh"
  REF_BACKUP_ALT="${HOME}/.openclaw/scripts/backup-vault-to-colludr.sh"
  REF="${REF_BACKUP_ALT}"
  [[ -f "${REF}" ]] || REF="${REF_BACKUP}"
  if [[ -f "${REF}" ]]; then
    run "sed 's/^HOST=\"colludr\"/HOST=\"${BACKUP_HOST}\"/' '${REF}' > '${BACKUP_SCRIPT}' && chmod +x '${BACKUP_SCRIPT}'"
    done_ "${STEP}" "backup script written to ${BACKUP_SCRIPT}"
  else
    manual "${STEP}" "reference backup-vault-to-colludr.sh not found; copy from master harness at ~/.openclaw/scripts/"
  fi
fi

# ─── Step 10: canvas-drift + log-rotator + memory-bridge-watcher ────────
STEP=10
DAEMONS=(canvas-drift log-rotator memory-bridge-watcher)
ALL_PRESENT=1
ANY_TEMPLATE=0
for d in "${DAEMONS[@]}"; do
  [[ -f "${LAUNCHAGENTS_DIR}/ai.openclaw.${d}.plist" ]] || ALL_PRESENT=0
  [[ -f "${OC_LAUNCHD_TEMPLATES}/ai.openclaw.${d}.plist" ]] && ANY_TEMPLATE=1
done
if [[ ${ALL_PRESENT} -eq 1 ]]; then
  skip "${STEP}" "canvas-drift + log-rotator + memory-bridge-watcher plists present"
elif [[ ${ANY_TEMPLATE} -eq 0 ]]; then
  # Nothing to do — no templates staged. Treat as a clean no-op on re-run.
  skip "${STEP}" "no daemon templates staged in ${OC_LAUNCHD_TEMPLATES}; nothing to reconcile"
else
  for d in "${DAEMONS[@]}"; do
    SRC="${OC_LAUNCHD_TEMPLATES}/ai.openclaw.${d}.plist"
    DST="${LAUNCHAGENTS_DIR}/ai.openclaw.${d}.plist"
    if [[ -f "${DST}" ]]; then
      info "  ${d}: already installed"
      continue
    fi
    if [[ -f "${SRC}" ]]; then
      run "cp '${SRC}' '${DST}'"
      [[ ${SAFE_MODE} -eq 0 ]] && run "launchctl load '${DST}'"
      info "  ${d}: installed"
    else
      info "  ${d}: template missing at ${SRC} — skipping (add template and re-run)"
    fi
  done
  done_ "${STEP}" "daemon plists reconciled"
fi

# ─── Step 11: Health check ──────────────────────────────────────────────
STEP=11
if [[ ${SAFE_MODE} -eq 1 ]]; then
  skip "${STEP}" "health check skipped in safe-mode"
else
  if curl -sf -o /dev/null http://localhost:18789/health; then
    done_ "${STEP}" "gateway health green"
  else
    fail "${STEP}" "gateway :18789 did not respond — check ~/.openclaw/logs/gateway.log"
  fi
fi

# ─── Summary ────────────────────────────────────────────────────────────
echo
info "summary: done=${STEPS_DONE} skipped=${STEPS_SKIPPED} manual=${STEPS_MANUAL} failed=${STEPS_FAILED}"

if [[ ${STEPS_FAILED} -gt 0 ]]; then
  exit 3
fi
exit 0
