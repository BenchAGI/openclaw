# Homebrew formula for OpenClaw — BenchAGI fork.
#
# Install (end-user):
#   brew tap benchagi/openclaw
#   brew install benchagi/openclaw/openclaw
#
# Note the tap-prefixed install command: an unrelated `openclaw` cask exists
# in homebrew-cask (an old WarCraft-style game remake) that collides on the
# short name, so bare `brew install openclaw` resolves to the cask. Always
# use the fully qualified name to disambiguate.
#
# Source: BenchAGI's published fork of OpenClaw on npm, scoped as
# @benchagi/openclaw. Includes Bench-specific patches that don't exist
# in the upstream `openclaw` package — memory-wiki canon indexing, the
# memory-state additive restore, the dreaming-narrative safe-fallback,
# the cliBackends partial-override, the memory-core wiki CLI activation,
# and the LCM CLI turn ingest.
#
# Cutover history: prior versions of this tap pulled the unscoped upstream
# `openclaw` tarball with a launchd watcher applying Bench patches at install
# time. As of 2026.5.2-beta.1 the patches are upstreamed into the published
# scoped package, so the runtime watcher is no longer required (it will be
# decommissioned after a 2-week soak).
class Openclaw < Formula
  desc "BenchAGI fork of OpenClaw — multi-channel AI gateway with Bench patches"
  homepage "https://github.com/BenchAGI/openclaw"
  url "https://registry.npmjs.org/@benchagi/openclaw/-/openclaw-2026.5.2-beta.1.tgz"
  # NOTE: replace this sha256 with the value from `npm view @benchagi/openclaw@2026.5.2-beta.1 dist.shasum`
  # immediately after `npm publish` completes. Until then this is a placeholder
  # and `brew install benchagi/openclaw/openclaw` will fail with a checksum mismatch.
  sha256 "REPLACE_AFTER_NPM_PUBLISH"
  license "MIT"

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  def caveats
    <<~EOS
      Next steps:
        1. Authorize OpenClaw with your default model provider:
             openclaw models auth login
        2. Start the gateway (defaults to localhost:18789):
             openclaw gateway start
        3. Verify with:
             curl http://localhost:18789/health

      Config lives in ~/.openclaw/openclaw.json — Bench's deploy runbooks
      document the shape of that file per role (Aurelius, Cole, Sage, etc).

      This is the BenchAGI fork (@benchagi/openclaw on npm). It ships the
      same `openclaw` CLI binary as upstream so existing scripts, skills,
      and shell aliases continue working. The fork carries Bench-specific
      patches already baked into the published tarball — no runtime patch
      step is required after install.

      Name collision note: always use the fully qualified name to install or
      upgrade (an unrelated openclaw cask exists in homebrew-cask):
        brew install benchagi/openclaw/openclaw
        brew upgrade benchagi/openclaw/openclaw
    EOS
  end

  test do
    # OpenClaw prints "OpenClaw <version> (<commit>)" to stdout for --version,
    # so we just assert the declared version appears in the output.
    assert_match version.to_s, shell_output("#{bin}/openclaw --version")
  end
end
