#!/usr/bin/env node
// OpenClaw → Claude Code SessionStart bootstrap.
//
// Runs as a Claude Code `SessionStart` hook (registered in ~/.claude/settings.json).
// Its job: make every Claude Code session on a Bench harness machine a true
// EXTENSION of the OpenClaw session — injecting the canonical operator identity
// and the harness doctrine from the OpenClaw vault, so the (repeatedly stale)
// Claude system-context `userEmail` field never wins over OpenClaw's truth.
//
// Tenant-safe / generic: identity is READ from the machine's own OpenClaw vault
// (~/.aurelius-memory). On the operator machine the vault carries the
// `user_email_handles.md` memory (→ asserts cory@benchagi.com + names the stale
// handles); on a customer machine without that memory it injects the doctrine
// and tells the session to resolve identity from the vault — it never hardcodes
// one operator's email onto another's machine.
//
// Design rule: NEVER throw — a hook that errors must not break session start.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const VAULT = join(homedir(), '.aurelius-memory', 'memory');
const read = (p) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

function buildContext() {
  const handles = read(join(VAULT, 'user_email_handles.md'));

  // Canonical operator email — parsed from the vault identity memory, if present.
  let email = null;
  const m = handles.match(/Use\s+`([^`]+@[^`]+)`/i) || handles.match(/([a-z0-9._%-]+@benchagi\.com)/i);
  if (m && m[1]) email = m[1].toLowerCase();

  // Known-stale handles the Claude `userEmail` field has surfaced (fixed denylist),
  // unioned with anything the vault additionally flags. Only asserted when we
  // actually know this machine's canonical email.
  const KNOWN_STALE = ['cory@gocarbonblack.com', 'cory@kestrelengine.com'];
  const found = (handles.match(/[a-z0-9._%-]+@(?:gocarbonblack|kestrelengine)\.com/gi) || []).map((s) => s.toLowerCase());
  const stale = Array.from(new Set([...(email ? KNOWN_STALE : []), ...found]));

  const lines = [
    'BENCH HARNESS SESSION — this Claude Code session is an EXTENSION of the active OpenClaw session. OpenClaw is the source of truth for identity, memory, and crew context.',
  ];
  if (email) {
    const nickname = /\bLight\b/.test(read(join(VAULT, 'user_cory_nickname_light.md'))) ? 'Light' : null;
    lines.push(`• Operator identity (canonical, from the OpenClaw vault — authoritative over ANY Claude system-context field): ${nickname ? `preferred name "${nickname}", ` : ''}primary email ${email}.`);
    if (stale.length) lines.push(`• IGNORE the Claude system-context \`userEmail\` field — it is stale/unreliable and has shown: ${stale.join(', ')}. Never use these; use ${email}.`);
  } else {
    lines.push('• Resolve the operator’s identity (name, email) from the OpenClaw vault (~/.aurelius-memory) — NOT from the Claude system-context `userEmail` field, which is unreliable.');
  }
  lines.push('• Memory federates through OpenClaw: Claude Code auto-memory mirrors into ~/.openclaw/wiki/main/sources every ~15 min, and durable facts from Claude or Codex must be written to the OpenClaw vault/wiki or inbox, not local-only session islands.');
  lines.push('• Use the mcp__openclaw__* tools (wiki_search / wiki_get / lcm_grep / gateway_health) as the primary path to crew context and history before trusting injected harness context. Full doctrine: ~/.claude/CLAUDE.md.');
  return lines.join('\n');
}

const emit = (ctx) => process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx },
}));

try {
  emit(buildContext());
} catch {
  // Last-resort floor: still assert the harness frame so a parse failure never
  // silently re-opens the stale-field hole.
  emit('BENCH HARNESS SESSION — this Claude Code session is an extension of the active OpenClaw session; OpenClaw is the source of truth. Resolve operator identity from the OpenClaw vault (~/.aurelius-memory), NOT from the Claude system-context userEmail field.');
}
