#!/bin/bash
# Bash 5.3 on Darwin can block while constructing a heredoc pipe.
if [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then
  exec /bin/bash "$0" "$@"
fi
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PIN="$ROOT_DIR/scripts/lib/openclaw-bun.json"
DESTINATION="${1:-}"
PLATFORM="${2:-}"
[[ "$#" -ge 3 && -n "$DESTINATION" ]] || { echo "Usage: $0 <runtime> <darwin|linux> <arm64|x64> [...]" >&2; exit 2; }
shift 2
case "$PLATFORM" in darwin|linux) ;; *) echo "ERROR: Unsupported Bun platform: $PLATFORM" >&2; exit 2 ;; esac
[[ "$PLATFORM" == darwin || "$#" -eq 1 ]] || { echo "ERROR: Linux Bun staging needs one architecture" >&2; exit 2; }
for arch in "$@"; do
  case "$arch" in arm64|x64) ;; *) echo "ERROR: Unsupported Bun architecture: $arch" >&2; exit 2 ;; esac
done
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openclaw-bun.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
TAG="$(node -p 'require(process.argv[1]).tag' "$PIN")"
CACHE_DIR="$ROOT_DIR/.cache/openclaw-bun/$TAG"
mkdir -p "$CACHE_DIR"
download() {
  local request_url="https://github.com/openclaw/bun/releases/download/$TAG/$1"
  local download_status=0
  curl --fail --location --proto '=https' --proto-redir '=https' --no-progress-meter --show-error \
    --connect-timeout 15 --max-time 300 --retry 3 --retry-delay 2 \
    --dump-header "$WORK/$1.headers" --write-out '%{http_code}\n%{url_effective}\n' \
    --output "$WORK/$1" "$request_url" > "$WORK/$1.transport" || download_status=$?
  if [[ "$download_status" -ne 0 ]]; then
    # The existing private WORK owner cleans raw response metadata on every exit.
    # Diagnostics cannot replace curl's failure or emit cookies, auth, or signed queries.
    node - "$download_status" "$WORK/$1.headers" "$WORK/$1.transport" "$request_url" <<'JS' 2>/dev/null || true
const fs = require('node:fs');
const { isIP } = require('node:net');
const [exitCode, headerPath, resultPath, requestUrl] = process.argv.slice(2);
const hostname = value => {
  try {
    const host = new URL(value).hostname;
    if (!host || host.length > 253) return '[omitted]';
    if (isIP(host) || (host.startsWith('[') && host.endsWith(']') && isIP(host.slice(1, -1)) === 6)) return host;
    const domain = host.endsWith('.') ? host.slice(0, -1) : host;
    return domain.split('.').every(label => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
      ? host : '[omitted]';
  } catch { return null; }
};
const safeHeader = (name, value) => {
  if (name === 'content-length') return /^\d{1,20}$/.test(value) ? value : '[omitted]';
  return value.length <= 160 && /^[A-Za-z0-9 .,/;()_-]+$/.test(value) &&
    !/\b(?:authorization|bearer|token|secret|password|signature)\b/i.test(value)
    ? value : '[omitted]';
};
try {
  if (fs.statSync(headerPath).size > 1048576 || fs.statSync(resultPath).size > 16384) throw new Error();
  const result = fs.readFileSync(resultPath, 'utf8').trimEnd().split('\n');
  const responses = [];
  let current;
  for (const line of fs.readFileSync(headerPath, 'utf8').split(/\r?\n/)) {
    const status = /^HTTP\/\S+\s+(\d{3})(.*)$/i.exec(line);
    if (status) {
      current = /connection established/i.test(status[2]) ? null : { status: Number(status[1]), headers: {} };
      if (current) responses.push(current);
      continue;
    }
    if (!current) continue;
    const header = /^([^:]+):\s*(.*)$/.exec(line);
    if (!header) continue;
    const name = header[1].toLowerCase();
    if (name === 'location') current.redirectHostname = hostname(header[2]);
    if (['server', 'via', 'x-cache', 'content-length'].includes(name)) current.headers[name] = safeHeader(name, header[2]);
  }
  const request = new URL(requestUrl);
  console.log('[download-failure] ' + JSON.stringify({
    curlExitCode: Number(exitCode), method: 'GET', requestHostname: request.hostname, requestPath: request.pathname,
    firstCapturedStatus: responses[0]?.status ?? null, finalStatus: Number(result[0]) || null,
    finalHostname: hostname(result[1]), responses: responses.slice(-32),
  }));
} catch {
  console.log('[download-failure] ' + JSON.stringify({ curlExitCode: Number(exitCode), diagnosticsUnavailable: true }));
}
JS
  fi
  return "$download_status"
}
download SHA256SUMS
download manifest.json
# The release metadata and independent source pin must agree before any payload runs.
node - "$PIN" "$WORK" "$PLATFORM" "$@" <<'JS'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const [pinPath, work, platform, ...arches] = process.argv.slice(2);
const pin = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
const sums = fs.readFileSync(`${work}/SHA256SUMS`, 'utf8').trim().split('\n');
function checksum(name) {
  const matches = sums.map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === name);
  assert.equal(matches.length, 1, `Missing or duplicate release checksum: ${name}`);
  return matches[0][0];
}
const bytes = fs.readFileSync(`${work}/manifest.json`);
assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), checksum('manifest.json'), 'Bun manifest sha256 mismatch');
const manifest = JSON.parse(bytes);
assert.equal(manifest.repository, 'openclaw/bun', 'Bun release repository mismatch');
assert.equal(manifest.tag, pin.tag, 'Bun release tag mismatch');
assert.equal(manifest.bun.commit, pin.commit, 'Bun release commit mismatch');
assert.equal(manifest.bun.revision, pin.revision, 'Bun release revision mismatch');
for (const arch of arches) {
  const target = `${platform}-${arch}`;
  const artifact = pin.artifacts[target];
  assert(artifact, `Missing pinned Bun target: ${target}`);
  const matches = manifest.assets.filter(asset => asset.target === target);
  assert.equal(matches.length, 1, `Missing or duplicate Bun release target: ${target}`);
  const published = matches[0];
  assert.deepEqual({asset: published.name, sha256: published.sha256, executable: published.executable.path, executableSha256: published.executable.sha256}, artifact, 'Bun release artifact differs from pin');
  assert.equal(checksum(artifact.asset), artifact.sha256, 'Bun release archive sha256 mismatch');
}
JS
INPUTS=()
for arch in "$@"; do
  read -r COMMIT REVISION ASSET ARCHIVE_SHA EXECUTABLE EXECUTABLE_SHA < <(node - "$PIN" "$PLATFORM-$arch" <<'JS'
const pin = require(process.argv[2]);
const artifact = pin.artifacts[process.argv[3]];
console.log(pin.commit, pin.revision, artifact.asset, artifact.sha256, artifact.executable, artifact.executableSha256);
JS
)
  mkdir -p "$WORK/$arch"
  actual=""
  if [[ -f "$CACHE_DIR/$ASSET" && ! -L "$CACHE_DIR/$ASSET" ]]; then
    actual="$(shasum -a 256 "$CACHE_DIR/$ASSET" | awk '{print $1}')"
  fi
  if [[ "$actual" != "$ARCHIVE_SHA" ]]; then
    download "$ASSET"
    [[ "$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')" == "$ARCHIVE_SHA" ]] || {
      echo "ERROR: Bun $ASSET sha256 mismatch" >&2; exit 1;
    }
    mv -f "$WORK/$ASSET" "$CACHE_DIR/$ASSET"
  fi
  # Extract the pinned executable's bytes only, never paths supplied by the zip.
  unzip -p "$CACHE_DIR/$ASSET" "$EXECUTABLE" > "$WORK/$arch/bun"
  [[ "$(shasum -a 256 "$WORK/$arch/bun" | awk '{print $1}')" == "$EXECUTABLE_SHA" ]] || {
    echo "ERROR: Bun executable checksum mismatch" >&2; exit 1;
  }
  chmod 0755 "$WORK/$arch/bun"
  EXECUTOR=()
  if [[ "$PLATFORM" == darwin ]]; then
    native_arch="${arch/x64/x86_64}"
    [[ "$(/usr/bin/lipo -archs "$WORK/$arch/bun")" == "$native_arch" ]] || {
      echo "ERROR: Bun executable architecture mismatch" >&2; exit 1;
    }
    EXECUTOR=(/usr/bin/arch -"$native_arch")
  else
    node - "$WORK/$arch/bun" "$arch" <<'JS'
const assert = require('node:assert/strict');
const bytes = require('node:fs').readFileSync(process.argv[2]);
assert(bytes.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) && bytes.readUInt16LE(18) === (process.argv[3] === 'arm64' ? 183 : 62), 'Bun executable architecture mismatch');
JS
  fi
  if [[ "$PLATFORM-$arch" == "$(node -p '`${process.platform}-${process.arch}`')" ]] ||
     { [[ "$PLATFORM" == darwin ]] && "${EXECUTOR[@]}" /usr/bin/true 2>/dev/null; }; then
    [[ "$("${EXECUTOR[@]}" "$WORK/$arch/bun" --revision)" == "$REVISION" &&
       "$("${EXECUTOR[@]}" "$WORK/$arch/bun" -p 'Bun.revision')" == "$COMMIT" ]] || {
      echo "ERROR: Bun fork revision mismatch" >&2; exit 1;
    }
  else
    echo "WARN: Bun $PLATFORM-$arch execution skipped; verify on a matching host (or Rosetta for Darwin x64)" >&2
  fi
  INPUTS+=("$WORK/$arch/bun")
done
mkdir -p "$DESTINATION/bin"
if [[ "${#INPUTS[@]}" -gt 1 ]]; then
  /usr/bin/lipo -create "${INPUTS[@]}" -output "$DESTINATION/bin/bun"
else
  cp "${INPUTS[0]}" "$DESTINATION/bin/bun"
fi
chmod 0755 "$DESTINATION/bin/bun"
cp "$PIN" "$DESTINATION/bun-manifest.json"
echo "Staged OpenClaw Bun $TAG [$PLATFORM ${*}]"
