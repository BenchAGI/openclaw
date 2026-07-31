import type { CodexThreadItem } from "./protocol.js";

const GIT_IDENTITY_FAILURE_PATTERNS = [
  /\bauthor identity unknown\b/i,
  /\bcommitter identity unknown\b/i,
  /\bunable to auto-detect email address\b/i,
];

const GIT_COMMIT_SEGMENT =
  /(?:^|&&|\|\||;|\n)\s*(git\s+commit\b[^;&\n|]*?)(?=\s*(?:&&|\|\||;|\n|$))/gi;

function normalizeCommandSegment(command: string): string {
  return command.trim().replace(/\s+/g, " ").toLowerCase();
}

function gitCommitSegments(command: string): string[] {
  return [...command.matchAll(GIT_COMMIT_SEGMENT)]
    .map((match) => match[1])
    .filter((segment): segment is string => Boolean(segment))
    .map(normalizeCommandSegment);
}

function isGitIdentityFailure(error: string | undefined): boolean {
  return Boolean(error && GIT_IDENTITY_FAILURE_PATTERNS.some((pattern) => pattern.test(error)));
}

/**
 * Identify a retried `git commit` after Git rejected the original only because
 * author identity was missing. The exact commit invocation and cwd must match;
 * every other compound-shell failure keeps the fail-closed full-command key.
 */
export function nativeCommandRecoveryFingerprint(
  item: CodexThreadItem,
  priorError: string | undefined,
): string | undefined {
  if (
    item.type !== "commandExecution" ||
    typeof item.command !== "string" ||
    !isGitIdentityFailure(priorError)
  ) {
    return undefined;
  }
  const segments = gitCommitSegments(item.command);
  if (segments.length !== 1) {
    return undefined;
  }
  return JSON.stringify({
    type: item.type,
    recovery: "gitCommitAfterIdentityConfiguration",
    command: segments[0],
    cwd: typeof item.cwd === "string" ? item.cwd : "",
  });
}
