# bench-reflective-dreaming

A lightweight OpenClaw extension that adds a **reflective-dreaming layer** on top
of memory-core's built-in sleep phases. Companion to `@openclaw/memory-core`.

## Why this exists

`memory-core` ships with three mechanical sleep phases (light / REM / deep) that
promote weighted recalls into `MEMORY.md`. It also includes `dreaming-narrative`
which writes poetic diary prose after each phase.

**Reflective dreaming is different**: it's a structured per-agent reflection pass
that produces an _ops log_ of what each agent actually did, what it learned, and
what patterns are emerging. After every agent dreams, a coordinator runs a
**fleet canon** pass — a single daily entry synthesizing across agents. A final
**consolidation** pass prunes stale memory.

Outputs land in the OpenClaw wiki vault (`~/.openclaw/wiki/main/dreams/`,
`synthesis/`, `canon/`). If you have the BenchAGI `cloud-mirror` daemon running
(it ships alongside this extension at
`extensions/claude-code-bridge/cloud-mirror.mjs`), the writes flow to the
Firebase `wikiEntries` collection and become visible in the BenchAGI web app at
`/admin/settings/agent-wiki/dreams` and `/wiki/canon`.

## What it provides

- **4 version-controlled prompt protocols** (`assets/prompts/*.md`) —
  dream-diary, fleet-canon, memory-consolidation, and Bailey's
  cory-attention-rules refresh (`bailey-attention-rules.md`). Installed to
  `~/.openclaw/wiki/main/concepts/` on `install.sh`.
- **Defaults** for which agents dream and when (`defaults/cron-schedule.json`).
- **Install/uninstall scripts** that add and remove the 7 managed cron jobs via
  `openclaw cron add` / `openclaw cron rm`.
- **Plugin manifest** (`openclaw.plugin.json`) — metadata stub; future upgrade
  path to a full TS plugin.

## Pipeline

```
02:30-02:46  per-agent dreams   (5 cron jobs, one per agent)
03:00        memory-core sleep  (upstream: light → REM → deep + narrative)
03:15        fleet canon        (coordinator synthesizes across agents)
03:40        consolidation      (pruning + safe auto-merges)
```

Reflective dreaming runs _before_ memory-core's 03:00 promotion so dreams inform
the same-cycle canon. Consolidation runs _after_ promotion so it can incorporate
MEMORY.md changes.

## Install

```bash
cd extensions/bench-reflective-dreaming
bash scripts/install.sh
```

The script is idempotent: safe to re-run on upgrade. It:

1. Copies `assets/prompts/*` into `~/.openclaw/wiki/main/concepts/` (preserves
   existing files by content-hash; only writes if changed).
2. Registers 7 cron jobs with the tag `[managed-by=bench-reflective-dreaming]`
   via `openclaw cron add`. Re-running updates schedules/messages in place.

## Uninstall

```bash
bash scripts/uninstall.sh
```

Removes managed cron jobs. Protocol files in the vault are left in place (you
may have approved rarity/status for them in Firebase; removing would create
drift).

## Relationship to upstream memory-core

- **Orthogonal, not replacing.** Both run. `memory-core.dreaming` is the
  mechanical/poetic layer; this extension adds the structured/reflective layer.
- **No code modifications to memory-core** — we only add to the cron registry
  and the vault concepts directory.
- **Safe to merge upstream updates.** This extension doesn't touch upstream
  code paths.
