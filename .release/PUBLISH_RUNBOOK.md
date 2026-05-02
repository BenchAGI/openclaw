# BenchAGI/openclaw → @benchagi/openclaw publish runbook (2026.5.2-beta.1)

This runbook captures the exact sequence to take the prepared release
branch (`release/benchagi-2026.5.2-bench.1` in this worktree) live on
npm and bump the homebrew tap. Everything up to "Stage 3 — npm publish"
has already been done; the rest waits on Cory's npm auth.

## State at handoff

- **Worktree**: `~/clawd/openclaw.benchagi-publish-prep` (release branch)
- **Branch**: `release/benchagi-2026.5.2-bench.1` (off `merge/upstream-2026.5.2`)
- **Built tarball**: `benchagi-openclaw-2026.5.2-beta.1.tgz` (27.6 MB, 9845 files)
- **Cory's main fork checkout** at `~/clawd/openclaw` is on `merge/upstream-2026.5.2`
  and is untouched. The daily `aurelius-vault-recall` probe stays green throughout.

## Stage 3 — npm publish (manual for v1)

### 3.1. npm auth

```bash
npm login                                           # interactive, browser-based
npm whoami                                          # confirm logged in
```

### 3.2. Confirm `@benchagi` org exists

```bash
npm org ls benchagi                                 # should NOT 404
```

If it 404s, create the org via npmjs.com web UI first:

- npmjs.com → Profile → Add Organization
- Likely needs npm Pro/Teams plan for public scoped packages
- Add your team members

### 3.3. Tag the release commit (release-check requires it)

```bash
cd ~/clawd/openclaw.benchagi-publish-prep
git tag -a v2026.5.2-beta.1 -m "BenchAGI fork release 2026.5.2-beta.1"
```

### 3.4. Push branch + tag to BenchAGI/openclaw

```bash
git push origin release/benchagi-2026.5.2-bench.1
git push origin v2026.5.2-beta.1
```

### 3.5. Run the release-check one more time (with the tag in env)

```bash
RELEASE_TAG=v2026.5.2-beta.1 pnpm release:openclaw:npm:check
# Expect: "validated beta release 2026.5.2-beta.1 (0 day UTC delta)."
```

### 3.6. Publish

```bash
# Tarball is already built and validated. Publish it directly:
npm publish benchagi-openclaw-2026.5.2-beta.1.tgz \
  --access public \
  --tag beta \
  --provenance
```

**Notes**:

- `--access public` is required for scoped packages on the free plan.
  publishConfig in package.json sets it too, but the explicit flag is belt-and-suspenders.
- `--tag beta` puts this on the `beta` dist-tag (not `latest`).
  Soak for 2-3 days before promoting:
  `npm dist-tag add @benchagi/openclaw@2026.5.2-beta.1 latest`
- `--provenance` requires npm trusted publishing OR a CI environment
  with `id-token: write` permissions. From a laptop without OIDC,
  drop `--provenance` — it'll publish without provenance, which is fine
  for v1 beta.

If `--provenance` errors, retry without it:

```bash
npm publish benchagi-openclaw-2026.5.2-beta.1.tgz --access public --tag beta
```

### 3.7. Capture the published shasum (needed for Stage 4)

```bash
npm view @benchagi/openclaw@2026.5.2-beta.1 dist.shasum
# Output: 64-character hex string. Save it; it's the tap formula sha256.
```

### 3.8. Run the postpublish verification

```bash
pnpm release:openclaw:npm:verify-published
```

### 3.9. Smoke-test in a clean env

```bash
mkdir -p /tmp/openclaw-smoke && cd /tmp/openclaw-smoke
npm install -g @benchagi/openclaw@2026.5.2-beta.1
openclaw --version          # should print "OpenClaw 2026.5.2-beta.1 (..)"
openclaw wiki status        # should show vault counts (proves wiki CLI works)
which openclaw              # should resolve to npm-global bin
```

## Stage 4 — Bump the homebrew tap formula

### 4.1. Take the draft formula and fill in the sha256

The draft is at `.release/homebrew-formula.rb` in this worktree.
Replace `REPLACE_AFTER_NPM_PUBLISH` with the value from step 3.7.

### 4.2. Apply to the live tap repo

```bash
cd /opt/homebrew/Library/Taps/benchagi/homebrew-openclaw
cp ~/clawd/openclaw.benchagi-publish-prep/.release/homebrew-formula.rb Formula/openclaw.rb
# Verify the placeholder got replaced:
grep REPLACE_AFTER_NPM_PUBLISH Formula/openclaw.rb && echo "STILL HAS PLACEHOLDER — fix before commit"

git add Formula/openclaw.rb
git commit -m "openclaw: bump to @benchagi/openclaw 2026.5.2-beta.1

First fork-published version on npm. Switches the tap from the upstream
\`openclaw\` package + runtime watcher to the @benchagi-scoped fork that
ships all Bench patches in source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
git push origin main
```

### 4.3. Test brew install from clean state

```bash
brew uninstall benchagi/openclaw/openclaw 2>/dev/null
rm -rf ~/.openclaw/.cache       # optional: ensure clean state
brew update
brew install benchagi/openclaw/openclaw
openclaw --version              # should match 2026.5.2-beta.1
```

## Stage 5 — Memory + watcher deprecation

### 5.1. Memory updates

After publish completes, update these memory entries (Claude can do
this autonomously):

- `project_benchagi_openclaw_release_blocker.md` → mark RESOLVED
- `reference_openclaw_local_fork_install_2026-05-02.md` → note that
  the npm publish path is now `@benchagi/openclaw`, brew install pulls
  the fork directly, watcher is deprecated
- New memory: `project_openclaw_fork_npm_publish_2026-05-02.md`
  with package coordinates and verification commands

### 5.2. Watcher deprecation (after 2-week soak)

The watcher at `~/Library/LaunchAgents/ai.openclaw.memory-bridge-watcher.plist`
is now redundant — the patches are in source. Don't disable yet; let the
new build soak for 2 weeks first (until 2026-05-16). When ready:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.memory-bridge-watcher.plist
mv ~/Library/LaunchAgents/ai.openclaw.memory-bridge-watcher.plist \
   ~/Library/LaunchAgents/ai.openclaw.memory-bridge-watcher.plist.disabled
# Keep the .disabled file for 1 more month before deleting, in case we need to revert.
```

## Things to verify if anything goes sideways

- The daily `aurelius-vault-recall` probe should stay green throughout.
  If it goes red, Cory's runtime broke — check `~/clawd/openclaw` is
  still on `merge/upstream-2026.5.2` and hasn't been switched.
- If `npm publish` rejects "402 Payment Required" — the @benchagi org
  needs npm Pro/Teams. Or rename to @benchagi-public or similar (free).
- If `npm publish` rejects "404 Scope not found" — the @benchagi org
  doesn't exist on npm yet (Cory needs to create it via npmjs.com).
- If `brew install` fails with checksum mismatch — the formula sha256
  doesn't match the published tarball; re-run step 3.7 and update.

## Rollback (if needed within 72 hours)

```bash
# Unpublish (only allowed within 72 hours of publish):
npm unpublish @benchagi/openclaw@2026.5.2-beta.1
# Roll back the tap:
cd /opt/homebrew/Library/Taps/benchagi/homebrew-openclaw
git revert HEAD
git push origin main
# Re-enable the runtime watcher (it's still there until Stage 5.2):
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.memory-bridge-watcher.plist
```

After 72 hours, npm only allows deprecation, not unpublish.
