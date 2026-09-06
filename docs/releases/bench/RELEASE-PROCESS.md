---
title: "Bench runtime line — release process"
summary: "How a BenchAGI OpenClaw customer release is cut from a bench-runtime-<upstream> branch, tagged, published, and delivered through the Homebrew tap."
---

# Bench runtime line — release process

The BenchAGI fork ships customers a **runtime line**: one branch per upstream
version (`bench-runtime-2026.9.2` = upstream tag `v2026.9.2` + the Bench
commits on top). A customer release is a tag on that branch, a GitHub release
carrying the built package, and a Homebrew tap formula pinned to that tag.
Nothing here deploys a customer; the relay's update path installs the formula
on each box under its own human gates.

## One build, one version

OpenClaw 2026.9.2 admits a same-host Control UI only when the page's
`client.buildId` equals the Gateway's runtime build id (`PROTOCOL_MISMATCH`
otherwise). The branded Control UI therefore **must ship inside the Gateway's
bundled `ui`**, built from the same commit as the Gateway. A separately served
UI (`controlUi.root`) is exempt from that check but loses build identity and is
not the customer path. Never publish a UI artifact for a different commit than
the Gateway it pairs with; the `bench-control-ui-artifact` workflow hashes the
UI against the package version and source head for exactly this reason.

## Version and tag scheme

- `package.json` `version` stays the **upstream** version (`2026.9.2`). The
  Gateway, the relay's `openclawVersion` readback, and the desktop Vault's
  minimum-version check all read that field.
- The release **tag** carries the Bench iteration: `v2026.9.2-bench.1`,
  `v2026.9.2-bench.2`, … The tap formula injects the tag as `GIT_RELEASE` and
  the exact commit as `GIT_COMMIT`, so `dist/build-info.json` preserves the
  lineage without editing `package.json`.
- A new upstream version means a new `bench-runtime-<version>` branch; the
  previous branch stays as the documented rollback line for its customers.

## Preconditions (all must be true on the exact commit to be tagged)

1. The commit is on `bench-runtime-<version>` and is the merge result of the
   reviewed PRs (no squash of unreviewed content).
2. `openclaw/ci-gate`, `security-fast` (runs only on non-draft PRs and on
   branch pushes), `bench-control-ui-artifact`, and the fork guards are green
   on that commit. A draft PR's "skipping" is a skip, not a pass.
3. The ADR-0005 trusted-ingress proof
   (`apps/relay/openclaw-canonical-session-proof.mjs` in the BenchAGI monorepo)
   passed against a Gateway built from this commit.
4. Release notes exist under `docs/releases/bench/<version>-bench.<n>.md`.

## Cut the release

```bash
# from a clean checkout of bench-runtime-2026.9.2 at the reviewed commit
export TAG=v2026.9.2-bench.1
export SOURCE_COMMIT="$(git rev-parse HEAD)"
git tag -a "$TAG" -m "OpenClaw 2026.9.2 — Bench release 1" "$SOURCE_COMMIT"
git push origin "refs/tags/$TAG"

# build the exact package the tap will build, and record its digest
pnpm install --frozen-lockfile
GIT_RELEASE="$TAG" GIT_COMMIT="$SOURCE_COMMIT" pnpm build:docker
npm pack --ignore-scripts                      # openclaw-2026.9.2.tgz
shasum -a 256 openclaw-2026.9.2.tgz > openclaw-2026.9.2.tgz.sha256

# source tarball digest for the formula (GitHub builds it from the tag)
curl -sL "https://github.com/BenchAGI/openclaw/archive/refs/tags/$TAG.tar.gz" | shasum -a 256

gh release create "$TAG" --target "$SOURCE_COMMIT" --draft \
  --title "OpenClaw 2026.9.2 — Bench release 1" \
  --notes-file docs/releases/bench/2026.9.2-bench.1.md \
  openclaw-2026.9.2.tgz openclaw-2026.9.2.tgz.sha256
```

The GitHub release stays **draft** until the owner publishes it. The release
body must name the exact source commit, the CI run ids that were green, the
package sha256, the canary cohort, and the rollback formula.

## Deliver through the tap

`BenchAGI/homebrew-tap` `Formula/openclaw.rb` is the customer delivery
mechanism (`apps/relay/update-relay.sh` in the monorepo runs
`brew install benchagi/tap/openclaw` and `brew upgrade` on each box). Bump, in
one PR on the tap:

- `url` → the new tag's source tarball,
- `version` → `2026.9.2-bench.1`,
- `sha256` → the source tarball digest computed above,
- `SOURCE_COMMIT` → the exact commit.

Do not merge the tap bump before the GitHub release is published; do not
publish the GitHub release before the tap PR is reviewed. Customer boxes only
move when the relay's update lane runs under its own cohort and human gates.

## Rollback

- Formula rollback: re-pin `Formula/openclaw.rb` to the previous customer
  release (`v2026.6.11-bench.1` today) and let the relay's update lane apply
  it; on-box, the relay keeps a pre-install snapshot and restarts the Gateway.
- Code rollback line: `bench-runtime-2026.8.1` (upstream 8.1 + branding) exists
  as a reviewed branch but **no customer release was ever cut from it**; a
  rollback to 8.1 would be a first release, not a return.
- The trusted-ingress relay proxy is inert unless activated; rolling the
  Gateway back does not by itself revoke ingress grants — follow ADR-0005's
  rollback list in the monorepo.
