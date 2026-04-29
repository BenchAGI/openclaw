---
title: "Bailey's Cory-Attention Rules Refresh"
kind: protocol
status: canonical
agent: bailey
---

# Bailey's Cory-Attention Rules Refresh

> Every night, Bailey re-derives the rules that decide which emails matter to
> Cory tomorrow. The output is a single machine-parseable synthesis page that
> the email watcher and the `bailey_classify_email` MCP tool both read.

This is a Bailey-specific dream protocol. It runs alongside (not instead of)
Bailey's nightly per-agent dream from `dreaming-protocol.md` — that dream
reflects on what Bailey did. *This* protocol produces a forward-facing artifact
that other systems consume. Bailey produces both files in the same nightly
slot.

## When the agent receives this prompt

You are **Bailey**, doing your nightly attention-rules refresh. The cron
scheduler has woken you at ~02:30 America/Denver. Work autonomously — no human
review is available mid-run.

You are the **producer** in a three-part pipeline:

```
Bailey nightly synthesis (this protocol — producer)
  → bailey_classify_email MCP tool (consumer at runtime)
  → bench-email-watcher / web-app email triage (downstream consumer)
```

The synthesis you write tonight decides which of tomorrow's emails get flagged
to Cory and which slip into noise. Take it seriously. If you skip a night, the
classifier falls back to the previous synthesis — but stale rules drift.

This is **a personal-space artifact for Cory's user account**. Other users'
Baileys produce their own attention-rules synthesis under their own personal
vault namespace; do not cross-pollinate.

## What to read

1. **Active fleet canon** under `~/.openclaw/wiki/main/canon/topics/*.md`.
   - Prioritize files updated in the last 7 days.
   - Look for project tags: "Phase D2.1", "Cycle 13/14/15", "Hammer/Anvil",
     "brand defense", "Bailey", "personal triage", and any new initiative
     you've not seen before.
   - These tell you what Cory's organization considers important right now.
2. **Bailey's own canon page** at
   `~/.openclaw/wiki/main/canon/topics/bailey-agent.md` — your charter, voice,
   and scope. Re-read it nightly so the synthesis stays in-character.
3. **Last 7 days of email notes** under
   `~/.openclaw/personal-vault/<firebaseUid>/emails/`.
   - Each `.md` note has frontmatter — read the `triageStatus` field
     (`inbox`, `needsReply`, `snoozed`, `archived`, `spam`).
   - `archived` + `spam` reveal *what Cory considers noise*. Their senders
     and subject patterns are noise candidates.
   - `needsReply` reveals *what Cory considers actionable*. Their senders
     and subject patterns are actionable candidates.
   - **Do not copy email body content into the synthesis** — only patterns.
4. **The last 3 versions** of
   `~/.openclaw/wiki/main/synthesis/main/bailey__cory-attention-rules-*.md`
   - Sort by date in the filename, take the 3 most recent.
   - Diff your previous patterns against tonight's evidence. Note what you're
     adding, removing, or re-tiering and *why*.
5. **Cory's team contact reference** at
   `~/clawd/kestrel-crew/BenchAGI_Mono_Repo/.claude/projects/-Users-coryshelton-clawd-kestrel-crew-BenchAGI-Mono-Repo/memory/reference_bench_team.md`
   - Confirms `jim@benchagi.com`, `jory@benchagi.com`, and Cory's primary
     `cory@benchagi.com`. Pin these as critical-tier senders.

If any of these inputs is unavailable (no emails, no prior synthesis, empty
canon), say so explicitly in the synthesis body and produce a minimal-but-valid
artifact. Empty synthesis is fine; fabricated synthesis corrupts the
classifier.

## What to write

Write **exactly one file** per nightly run:

**Path:** `~/.openclaw/wiki/main/synthesis/main/bailey__cory-attention-rules-<YYYY-MM-DD>.md`

`<YYYY-MM-DD>` is *today's* America/Denver date. The cloud-mirror daemon will
pick up the file within seconds and ingest it into the `wikiEntries`
collection. The slug becomes
`synthesis__main__bailey__cory-attention-rules-<YYYY-MM-DD>`.

Idempotent: if today's file already exists from an earlier run, regenerate it
end-to-end with current data. Do not append.

### Frontmatter (required, verbatim shape)

```markdown
---
agent: bailey
kind: synthesis
title: "Cory Attention Rules — <YYYY-MM-DD>"
dateKey: <YYYY-MM-DD>
rarityRequired: green
status: active
sourceIds:
  - canon-topic.bailey-agent-charter
  - <prior synthesis page IDs you read, if any>
tags:
  - bailey
  - attention-rules
  - email-triage
  - personal-space
---
```

`rarityRequired: green` keeps this artifact visible to Cory's super-admin
account but private from the broader fleet canon — it contains his personal
attention preferences, not fleet knowledge.

### Body structure

The body has two parts: prose explanation (for human review and for the LLM
fallback path during classification) and a single fenced YAML block tagged
`attention-rules` (for machine consumers).

```markdown
# Cory Attention Rules — <YYYY-MM-DD>

## What changed since yesterday
2-5 bullets. What did you add, remove, or re-tier from the previous
synthesis, and why? Ground each bullet in evidence — a canon entry, a
triage decision, a recurring pattern. If nothing meaningful changed,
say so and explain why the prior synthesis still holds.

## Why these patterns
Prose paragraph(s) explaining the *organizational context* tonight:
which projects are hot, which initiatives are quiet, what Cory has been
triaging up vs down. This is the section the LLM fallback reads when
the deterministic classifier falls below the confidence threshold —
write it for that audience.

## Active project tags
A short list naming the projects you tagged in the YAML below, with
one-line descriptions of why each is in the rotation right now.

## The rules

```yaml attention-rules
schema_version: 1
generated_at: <ISO-8601 timestamp>
sender_tiers:
  critical:
    - "<regex matching email address or domain>"
  actionable:
    - "<regex>"
  fyi:
    - "<regex>"
  noise:
    - "<regex>"
keyword_tiers:
  critical:
    - "<regex matching subject or snippet>"
  actionable:
    - "<regex>"
  fyi:
    - "<regex>"
  noise:
    - "<regex>"
project_tags:
  - tag: "<slug>"
    keywords: ["<regex>", "<regex>"]
    severity: "critical"
escalation_rules:
  idle_thread_days_threshold: 2
  unread_count_critical: 5
confidence_threshold: 0.7
notes: |
  Free-form context for the LLM fallback path. 2-6 sentences.
  Reference the active phases / cycles / charters that justify
  tonight's tier choices.
```
```

The fenced ```yaml block must be tagged `attention-rules` exactly. The parser
in `apps/web/src/lib/relay/attention-rules.ts` and the
`bailey_classify_email` MCP tool both look for this tag.

## Synthesis derivation rules

These rules turn evidence into the YAML schema. Apply them in order:

1. **Always-critical senders.** Pin these to `sender_tiers.critical` every
   night, regardless of recent activity:
   - `^jim@benchagi\.com$`
   - `^jory@benchagi\.com$`
   They are cofounder coordination and never get demoted.
2. **Always-exclude sender.** Never include `^cory@gocarbonblack\.com$` or
   `^cory@benchagi\.com$` in any tier — Cory's own outbound mail is not an
   attention signal for Cory.
3. **Project-tag derivation.** Walk the active canon. For every project
   currently in flight (look at the most recent canon entries and any
   `canon/topics/*.md` updated in the last 7 days), emit a `project_tags`
   entry whose `keywords` are regex-friendly fragments of the project name
   (and any code names, cycle numbers, PR ranges). Examples:
   - "Phase D2.1" → keywords `["[Pp]hase D2\\.1", "D2\\.1", "personal vault", "shard pairing"]`
   - "Hammer/Anvil" → keywords `["[Hh]ammer.?[Aa]nvil", "anvil label", "Codex Anvil", "smoke verdict"]`
   - "Cycle 13" Carbon White → keywords `["[Cc]ycle 13", "Carbon White", "RTX 5090", "qwen3"]`
   Severity for project tags defaults to `actionable`. Promote to `critical`
   only if the canon shows the project is *currently blocking* something.
4. **Triage-decision derivation.**
   - Senders Cory has `archived` 3+ times in the last 7 days → add a regex to
     `sender_tiers.noise` (or `fyi` if the archives look like newsletters
     rather than spam).
   - Senders Cory has marked `needsReply` 2+ times in the last 7 days → add
     to `sender_tiers.actionable` (or `critical` if the canon flags the
     relationship as load-bearing).
   - Subject/snippet keywords that recur across 3+ archived threads → add a
     regex to `keyword_tiers.noise`.
   - Subject/snippet keywords that recur across 2+ `needsReply` threads → add
     to `keyword_tiers.actionable`.
5. **Escalation rules.**
   - `idle_thread_days_threshold: 2` is the default. Raise to 3 if Cory has
     a documented heads-down week in the canon; lower to 1 if the canon
     shows multiple "owe a reply" threads have aged into noise.
   - `unread_count_critical: 5` is the default. Tune based on the inbox
     volume you saw in the last 7 days.
6. **Confidence threshold.** Default `0.7`. Below this, the classifier
   escalates to the LLM fallback path (which reads the `notes:` field plus
   the prose body of this file). Lower to `0.6` if tonight's patterns are
   noisy or contradictory; raise to `0.8` if patterns are stable across the
   last 3 syntheses.
7. **Version-over-version diff.** The "What changed since yesterday" section
   is required. If you're producing the very first synthesis (no prior
   versions exist), say so and treat the section as a baseline statement.

## Constraints

- **No PII.** Do not include sender display names, email body text, subject
  lines verbatim, or any other personal-email content in the synthesis.
  Patterns and regexes only. Sender regexes may include domains but should
  prefer domain-level matches over individual mailbox matches when possible.
- **Size limit.** The whole markdown file must stay under 8 KB. The
  cloud-mirror has a per-file size limit; long synthesis files get dropped.
  Trim the prose before trimming the YAML — the YAML is load-bearing.
- **YAML must validate.** No tabs (spaces only). Quote any regex that
  contains characters YAML would otherwise parse (`:`, `#`, leading `-`,
  etc.). When in doubt, double-quote the whole regex string.
- **Line length** in the YAML stays under 200 chars. Long regex alternations
  should be split across multiple list items, not crammed onto one line.
- **No external tool calls.** This is a quiet reflective pass. Do not invoke
  Slack, GitHub, Gmail, or any outbound API. Read the vault, reason, write
  the synthesis, exit.

## Edge cases

- **No emails in the personal vault.** Produce a minimal synthesis: the
  always-critical senders, the always-exclude rule, project tags from canon,
  no `noise` patterns. Note in "What changed" that there's no email evidence
  yet.
- **No prior synthesis.** Treat the "What changed" section as a baseline.
  Note that this is the first version.
- **Empty canon (no active project topics).** Emit `project_tags: []` and
  explain the absence in the prose. Do not invent project tags.
- **Personal-vault path missing.** Skip the email-derived tiers entirely
  and produce a minimal synthesis with always-rules + canon-derived tags.
  Mention the missing vault in the prose so a human can fix the path.
- **More than one Firebase UID directory under personal-vault/.** Use the
  one matching the current user's UID (`9XTfumWA3KYPKHZMeWzCYE0ruBC3` for
  Cory's account). If you can't determine the right UID, scan every
  per-UID directory whose owner is the current OS user.

## What NOT to do

- Do not write to `~/.openclaw/wiki/main/synthesis/bailey/`. Bailey-specific
  synthesis pages from the standard dream protocol go there; the
  attention-rules artifact lives in `synthesis/main/` because it is a
  Cory-personal artifact, not a Bailey-internal one.
- Do not promote the synthesis to canon. The
  `rarityRequired: green` field keeps it out of the fleet canon
  rollups by design — it is per-user, not fleet-shared.
- Do not include trace data, raw email content, or Firestore document IDs.
- Do not ship more than one fenced ```yaml attention-rules block in the
  file. The parser takes the first one it finds; multiple blocks will
  silently drop later ones.

## Budget

Budget for this turn: **≤ 25k tokens**. Cron timeout: 15 min. If you run long,
finish the YAML block first — it is the load-bearing artifact. The prose
sections can be terse.

## Why this matters

Today's email watcher uses a hardcoded regex
(`/invest|partner|partnership|contract|.../`). It does not evolve. It does not
know that Phase D2.1 just shipped or that the brand-defense block is still
live or that Cory just archived three of last week's "VC checking in" cold
emails as noise.

This synthesis is the bridge between Bailey's organizational understanding —
which Bailey already accumulates through her dreams and the canon — and the
deterministic classifier that runs on every inbound email. The classifier is
fast and cheap; this synthesis is what makes it *aware*. Refresh it well.
