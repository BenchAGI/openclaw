#!/usr/bin/env bash
# Bash wrapper around install.mjs. Use whichever you prefer.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node "$SCRIPT_DIR/install.mjs" "$@"
