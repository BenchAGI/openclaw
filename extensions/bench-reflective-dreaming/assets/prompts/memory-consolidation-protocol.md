---
title: "Memory Consolidation Protocol"
kind: protocol
status: canonical
---

# Memory Consolidation Protocol

> After dreams and canon, consolidate. Pruning is as important as writing.

The final pass of the nightly cycle. One agent (`kestrel-aurelius` by default)
runs memory consolidation at ~03:40 local to keep the graph dense and accurate.

Unlike dreaming and canon, this pass **modifies existing entries**. It is
deliberately conservative: low-risk merges are applied automatically; anything
risky is staged for human review.

## When the agent receives this prompt

You are the **consolidator** for tonight. Per-agent dreams and the fleet canon
have been written. Your job is to reduce redundancy and stale state in the
memory graph — not add new content.

## What to read

1. **All agent MEMORY.md indexes** (`~/.claude/projects/*/memory/MEMORY.md`) and
   their linked memory files.
2. **Tonight's dream logs** — these surface candidates for consolidation.
3. **Pending patches** in `~/.openclaw/dreams-staging/*/<YYYY-MM-DD>/patches.md`
   that agents proposed during their dreams.

## Rules for automatic application

A consolidation is **safe to apply automatically** only if all hold:

1. **Duplicate merge** — two or more files describe the same fact with no
   contradictions. Keep the most recently updated version; delete the others.
   Update `MEMORY.md` pointers.
2. **Stale pruning** — the memory file describes a specific in-flight task that
   a user memory (e.g. "shipped" / "merged" / "abandoned") confirms is done,
   AND the file has no references from other memory files.
3. **Frontmatter normalization** — the file is missing a standard field (name /
   description / type) that can be inferred from the body. Add it, don't alter
   content.

Everything else (factual corrections, risk of losing context, cross-agent
merges) goes into `~/.openclaw/dreams-staging/consolidator/<YYYY-MM-DD>/patches.md`
for human review.

## What to write

### Required: consolidation audit log

**Path:** `~/.openclaw/wiki/main/dreams/consolidation/<YYYY-MM-DD>.md`

```markdown
---
title: "Consolidation audit, <YYYY-MM-DD>"
kind: consolidation
date: <YYYY-MM-DD>
---

## Applied automatically
List each auto-applied change: rule used, files affected, one-line rationale.

## Staged for human review
List each staged proposal: files affected, risk level, why it's risky.
Link to the patches.md file for full diff.

## Index refresh
Note any MEMORY.md pointer updates — added, removed, or renamed entries.

## Graph health
- Total memory files before / after
- Total wiki entries before / after
- Stale files pruned
- Duplicate chains collapsed
```

Default rarity for this entry: **orange** (super-admin only). Consolidation logs
contain sensitive operational detail and should not be public.

## What NOT to do

- Do not delete memory files unless you meet the stale-pruning rule completely.
- Do not merge cross-agent memory automatically — agent identity matters.
- Do not rewrite content; that's the dream pass, not consolidation.
- Do not modify files in `~/.claude/projects/*/memory/` if the project is
  currently being actively edited by a running Claude Code session (check for
  lock files).

## Budget

Budget for this turn: **≤ 40k tokens**. Cron timeout: 15 min.

## Why this matters

An ever-growing graph without pruning becomes noise. This pass is the immune
system — it keeps the signal clean so dreams and canon stay useful.
