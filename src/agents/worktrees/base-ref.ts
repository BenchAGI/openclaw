import { requireGitCommandOutput } from "../../infra/git-exec.js";
import { commandError, requireGit, runGit } from "./git.js";

type ResolvedWorktreeBase = {
  gitOperand: string;
  recordRef: string;
};

export async function resolveWorktreeBase(
  repoRoot: string,
  baseRef?: string,
  signal?: AbortSignal,
): Promise<ResolvedWorktreeBase> {
  if (baseRef) {
    let gitOperand = baseRef;
    if (baseRef !== "-" && baseRef.startsWith("-")) {
      // `worktree add -b` forwards its start point to `git branch`, which parses
      // options again without another `--`; normalize dashed refs before that hop.
      // Force strict lookup so repository config cannot hide ambiguous ref names.
      const symbolic = await runGit(repoRoot, [
        "-c",
        "core.warnAmbiguousRefs=true",
        "rev-parse",
        "--symbolic-full-name",
        "--verify",
        "--end-of-options",
        baseRef,
      ]);
      const fullRef = requireGitCommandOutput(
        "git rev-parse --symbolic-full-name --verify",
        symbolic,
      ).trim();
      if (fullRef) {
        if (!fullRef.startsWith("refs/") || fullRef.includes("\n")) {
          throw commandError("git rev-parse --symbolic-full-name --verify", symbolic);
        }
        gitOperand = fullRef;
      } else {
        if (symbolic.stderr.trim()) {
          throw commandError("git rev-parse --symbolic-full-name --verify", symbolic);
        }
        gitOperand = await requireGit(repoRoot, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${baseRef}^{commit}`,
        ]);
      }
    }
    return { gitOperand, recordRef: baseRef };
  }
  const remotes = (await requireGit(repoRoot, ["remote"], { signal })).split("\n").filter(Boolean);
  if (remotes.length === 0) {
    return {
      gitOperand: await requireGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], {
        signal,
      }),
      recordRef: "HEAD",
    };
  }
  if (!remotes.includes("origin")) {
    throw new Error(
      "Automatic worktrees require origin; configure it or choose an explicit base ref.",
    );
  }
  // The cached origin/HEAD can outlive a default-branch rename. Ask the remote,
  // then fetch that branch explicitly (including narrow/single-branch clones).
  const advertised = await requireGit(repoRoot, ["ls-remote", "--symref", "origin", "HEAD"], {
    signal,
  });
  const remoteRef = /^ref: (refs\/heads\/[^\s]+)\s+HEAD$/mu.exec(advertised)?.[1];
  if (!remoteRef) {
    throw new Error(
      "Origin has no resolvable default branch; repair its HEAD or choose an explicit base ref.",
    );
  }
  const trackingRef = `refs/remotes/origin/${remoteRef.slice("refs/heads/".length)}`;
  await requireGit(repoRoot, ["fetch", "--no-tags", "origin", `+${remoteRef}:${trackingRef}`], {
    signal,
  });
  const commit = await requireGit(repoRoot, ["rev-parse", "--verify", `${trackingRef}^{commit}`], {
    signal,
  });
  await requireGit(repoRoot, ["symbolic-ref", "refs/remotes/origin/HEAD", trackingRef], { signal });
  signal?.throwIfAborted();
  return { gitOperand: commit, recordRef: trackingRef };
}
