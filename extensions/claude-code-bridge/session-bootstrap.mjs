#!/usr/bin/env node
// OpenClaw -> Claude Code SessionStart bootstrap.
//
// Runs as a Claude Code `SessionStart` hook (registered in ~/.claude/settings.json).
// Its job: make every Claude Code session on a Bench harness machine a true
// EXTENSION of the OpenClaw session - injecting the canonical operator identity
// and the harness doctrine from the OpenClaw vault, so the (repeatedly stale)
// Claude system-context `userEmail` field never wins over OpenClaw's truth.
//
// Tenant-safe / generic: identity is READ from the machine's own OpenClaw vault
// (~/.aurelius-memory). When the vault has an identity memory, this hook uses
// it; otherwise it injects only the doctrine and asks Claude to resolve identity
// from the vault. Do not ship operator-specific fallback handles here.
//
// Design rule: NEVER throw - a hook that errors must not break session start.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VAULT = join(homedir(), ".aurelius-memory", "memory");
const read = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
};

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const CANONICAL_EMAIL_PATTERN =
  /^\s*(?:[-*]\s*)?(?:use\b|primary email\b|canonical\b[^:\n]*:?)[^@\n`]*?`?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})`?/i;

function emailsFrom(value) {
  return (value.match(EMAIL_PATTERN) || []).map((email) => email.toLowerCase());
}

function isStaleIdentityLine(line) {
  return /\b(?:stale|unreliable|ignore|wrong|old|retired|do not use)\b/i.test(line);
}

function readCanonicalEmail(handles) {
  const lines = handles.split(/\r?\n/);
  for (const line of lines) {
    const explicit = line.match(CANONICAL_EMAIL_PATTERN);
    if (explicit?.[1]) {
      return explicit[1].toLowerCase();
    }
  }
  const positiveLines = lines.filter((line) => !isStaleIdentityLine(line));
  return emailsFrom(positiveLines.join("\n"))[0] ?? null;
}

function readStaleEmails(handles, canonicalEmail) {
  const stale = new Set();
  for (const line of handles.split(/\r?\n/)) {
    if (!isStaleIdentityLine(line)) {
      continue;
    }
    for (const email of emailsFrom(line)) {
      if (email !== canonicalEmail) {
        stale.add(email);
      }
    }
  }
  return Array.from(stale);
}

function buildContext() {
  const handles = read(join(VAULT, "user_email_handles.md"));

  // Canonical operator email, parsed from the vault identity memory if present.
  const email = readCanonicalEmail(handles);
  const stale = email ? readStaleEmails(handles, email) : [];

  const lines = [
    "BENCH HARNESS SESSION - this Claude Code session is an EXTENSION of the active OpenClaw session. OpenClaw is the source of truth for identity, memory, and crew context.",
  ];
  if (email) {
    lines.push(
      `- Operator identity (canonical, from the OpenClaw vault, authoritative over ANY Claude system-context field): primary email ${email}.`,
    );
    if (stale.length) {
      lines.push(
        `- IGNORE the Claude system-context \`userEmail\` field. It is stale/unreliable and has shown: ${stale.join(", ")}. Never use these; use ${email}.`,
      );
    }
  } else {
    lines.push(
      "- Resolve the operator's identity (name, email) from the OpenClaw vault (~/.aurelius-memory), NOT from the Claude system-context `userEmail` field, which is unreliable.",
    );
  }
  lines.push(
    "- Memory federates through OpenClaw: Claude Code auto-memory mirrors into ~/.openclaw/wiki/main/sources every ~15 min, and durable facts from Claude or Codex must be written to the OpenClaw vault/wiki or inbox, not local-only session islands.",
  );
  lines.push(
    "- Use the mcp__openclaw__* tools (wiki_search / wiki_get / gateway_health) as the primary path to crew context and history before trusting injected harness context. Full doctrine: ~/.claude/CLAUDE.md.",
  );
  return lines.join("\n");
}

const emit = (ctx) =>
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: ctx },
    }),
  );

try {
  emit(buildContext());
} catch {
  // Last-resort floor: still assert the harness frame so a parse failure never
  // silently re-opens the stale-field hole.
  emit(
    "BENCH HARNESS SESSION - this Claude Code session is an extension of the active OpenClaw session; OpenClaw is the source of truth. Resolve operator identity from the OpenClaw vault (~/.aurelius-memory), NOT from the Claude system-context userEmail field.",
  );
}
