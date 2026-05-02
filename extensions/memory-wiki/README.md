# @openclaw/memory-wiki

Persistent wiki compiler and Obsidian-friendly knowledge vault for **OpenClaw**.

This plugin is separate from the active memory plugin. The active memory plugin still handles recall, promotion, and dreaming. `memory-wiki` compiles durable knowledge into a navigable markdown vault with deterministic indexes, provenance, structured claim/evidence metadata, and optional Obsidian CLI workflows.

When the active memory plugin exposes shared recall, agents can use `memory_search` with `corpus=all` to search durable memory and the compiled wiki in one pass, then fall back to `wiki_search` / `wiki_get` when wiki-specific ranking or provenance matters.

## Modes

- `isolated`: own vault, own sources, no dependency on `memory-core`
- `bridge`: reads public memory artifacts and memory events through public seams
- `unsafe-local`: explicit same-machine escape hatch for private local paths

Default mode is `isolated`.

## Config

Put config under `plugins.entries.memory-wiki.config`:

```json5
{
  vaultMode: "isolated",

  vault: {
    // Omit path to use the instance-scoped default:
    // ~/.openclaw/wiki/{instanceId}, or ~/.openclaw/wiki/main when unset.
    // path: "~/custom/wiki",
    renderMode: "obsidian", // or "native"
  },

  obsidian: {
    enabled: true,
    useOfficialCli: true,
    vaultName: "OpenClaw Wiki",
    openAfterWrites: false,
  },

  bridge: {
    enabled: false,
    readMemoryArtifacts: true,
    indexDreamReports: true,
    indexDailyNotes: true,
    indexMemoryRoot: true,
    followMemoryEvents: true,
  },

  unsafeLocal: {
    allowPrivateMemoryCoreAccess: false,
    paths: [],
  },

  ingest: {
    autoCompile: true,
    maxConcurrentJobs: 1,
    allowUrlIngest: true,
  },

  search: {
    backend: "shared", // or "local"
    corpus: "wiki", // or "memory" | "all"
  },

  context: {
    includeCompiledDigestPrompt: false, // opt in to append a compact compiled digest snapshot to memory prompt sections
  },

  render: {
    preserveHumanBlocks: true,
    createBacklinks: true, // writes managed ## Related blocks with sources, backlinks, and related pages
    createDashboards: true,
  },
}
```

## Vault shape

The plugin initializes a vault like this:

```text
<vault>/
  AGENTS.md
  WIKI.md
  index.md
  inbox.md
  entities/
  concepts/
  syntheses/
  sources/
  reports/
  _attachments/
  _views/
  .openclaw-wiki/
```

Generated content stays inside managed blocks. Human note blocks are preserved.

Key beliefs can live in structured `claims` frontmatter with per-claim evidence, confidence, and status. Compile also emits machine-readable digests under `.openclaw-wiki/cache/` so agent/runtime consumers do not have to scrape markdown pages.

When `render.createBacklinks` is enabled, compile adds deterministic `## Related` blocks to pages. Those blocks list source pages, pages that reference the current page, and nearby pages that share the same source ids.

When `render.createDashboards` is enabled, compile also maintains report dashboards under `reports/` for open questions, contradictions, low-confidence pages, and stale pages.

## CLI

```bash
openclaw wiki status
openclaw wiki doctor
openclaw wiki init
openclaw wiki ingest ./notes/alpha.md
openclaw wiki compile
openclaw wiki lint
openclaw wiki repair                    # backfill missing id/pageType/title/updatedAt
openclaw wiki repair --remove-orphans   # also delete empty source shells
openclaw wiki repair --dry-run          # report orphans without writing
openclaw wiki search "alpha"
openclaw wiki get entity.alpha --from 1 --lines 80

openclaw wiki apply synthesis "Alpha Summary" \
  --body "Short synthesis body" \
  --source-id source.alpha

openclaw wiki apply metadata entity.alpha \
  --source-id source.alpha \
  --status review \
  --question "Still active?"

openclaw wiki bridge import
openclaw wiki unsafe-local import

openclaw wiki obsidian status
openclaw wiki obsidian search "alpha"
openclaw wiki obsidian open syntheses/alpha-summary.md
openclaw wiki obsidian command workspace:quick-switcher
openclaw wiki obsidian daily
```

## Canonical page standard

Every page under `entities/`, `concepts/`, `sources/`, `syntheses/`, or `reports/` is expected to carry the following frontmatter. These are the fields the linter enforces and the ones the compiler will auto-repair if missing.

| Field       | Required             | Notes                                                                                          |
| ----------- | -------------------- | ---------------------------------------------------------------------------------------------- |
| `id`        | yes (error if blank) | Stable. Form: `<kind>.<slug>` (e.g. `concept.dreaming-protocol`). Derived from filename/title. |
| `pageType`  | yes (error if blank) | Must match the directory kind (`source`, `entity`, `concept`, `synthesis`, `report`).          |
| `title`     | yes (error if blank) | First H1 if present, otherwise humanized filename.                                             |
| `updatedAt` | yes (warn if blank)  | ISO 8601. Set by the generator on create or file mtime on repair.                              |
| `sourceIds` | recommended          | Required for non-source, non-report pages to avoid the `missing-source-ids` warning.           |

Generators (ingest, bridge, unsafe-local, synthesis apply, dashboard reports) are responsible for emitting all required fields at creation time. The compile pass runs a deterministic `ensurePageStructure` sweep that backfills anything still missing. `wiki repair` exposes that sweep as an explicit command for legacy content, including orphan-shell cleanup.

### Provenance discipline

- **Sources** never carry `sourceIds` — they _are_ the provenance. They must carry `sourcePath` plus one of `bridgeRelativePath`/`unsafeLocalRelativePath` when imported.
- **Syntheses, concepts, entities** should cite at least one `sourceIds` entry so the related-block/backlink graph can link them to their evidence.
- **Reports** are compiled artifacts. Their id/title/pageType are hardcoded by the dashboard definitions and should not be edited manually.

### Orphan shells

An "orphan shell" is a `sources/*.md` file whose entire body is just the managed `## Related` block (or is empty). These accumulate when a bridge-synced upstream source disappears partway through a sync, or when a compile pass touched a zero-byte stub. `wiki repair --remove-orphans` deletes them. `wiki repair --dry-run` reports them without changes.

## Daily operator workflow

The normal maintenance loop is three commands:

```bash
openclaw wiki bridge import   # pull in new memory artifacts
openclaw wiki compile          # refresh indexes, backlinks, dashboards, digests
openclaw wiki lint             # write the lint report
```

For a freshly-inherited or long-neglected vault, prepend an explicit repair:

```bash
openclaw wiki repair --dry-run            # preview orphans
openclaw wiki repair --remove-orphans     # then commit the cleanup
openclaw wiki compile
openclaw wiki lint
```

The lint report is idempotent and written to `reports/lint.md`. Errors indicate structural violations (missing id, missing pageType, type mismatch, duplicate id); warnings indicate content-health issues (stale pages, open questions, contradictions, claim health).

## Agent tools

- `wiki_status`
- `wiki_lint`
- `wiki_apply`
- `wiki_search`
- `wiki_get`

The plugin also registers a non-exclusive memory corpus supplement, so shared `memory_search` / `memory_get` flows can reach the wiki when the active memory plugin supports corpus selection.

`wiki_apply` accepts structured `claims` payloads for synthesis and metadata updates, so the wiki can store claim-level evidence instead of only page-level prose.

When `context.includeCompiledDigestPrompt` is enabled, the memory prompt supplement also appends a compact snapshot from `.openclaw-wiki/cache/agent-digest.json`. Legacy prompt assembly sees that automatically, and non-legacy context engines can pick it up when they explicitly consume memory prompt supplements via `buildActiveMemoryPromptSection(...)`.

## Gateway RPC

Read methods:

- `wiki.status`
- `wiki.doctor`
- `wiki.search`
- `wiki.get`
- `wiki.obsidian.status`
- `wiki.obsidian.search`

Write methods:

- `wiki.init`
- `wiki.compile`
- `wiki.ingest`
- `wiki.lint`
- `wiki.bridge.import`
- `wiki.unsafeLocal.import`
- `wiki.apply`
- `wiki.obsidian.open`
- `wiki.obsidian.command`
- `wiki.obsidian.daily`

## Notes

- `unsafe-local` is intentionally experimental and non-portable.
- Bridge mode reads the active memory plugin through public seams only.
- Wiki pages are compiled artifacts, not the ultimate source of truth. Keep provenance attached to raw sources, memory artifacts, and daily notes.
- The compiled agent digests in `.openclaw-wiki/cache/agent-digest.json` and `.openclaw-wiki/cache/claims.jsonl` are the stable machine-facing view of the wiki.
- Obsidian CLI support requires the official `obsidian` CLI to be installed and available on `PATH`.
