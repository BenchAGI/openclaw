# claude-code-bridge

Standalone MCP server that exposes OpenClaw (gateway, agents, memory wiki) as tools inside Claude Code sessions.

## Architecture

Hand-authored ESM files and launchd templates, no build step, no openclaw plugin SDK dependency:

| File                                     | Role                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serve.mjs`                              | Stdio MCP server. Registers 10 tools. Spawned by Claude Code via `mcpServers` config.                                                                                      |
| `session-bootstrap.mjs`                  | Claude Code `SessionStart` hook. Injects the OpenClaw source-of-truth frame, operator identity guidance, and durable-memory write path into every new Claude Code session. |
| `mirror.mjs`                             | One-shot local mirror: recursively copies Claude Code project memory files into `~/.openclaw/wiki/main/sources/claude-code-<origin>-*.md` as bridge-style source pages.    |
| `cloud-mirror.mjs`                       | Long-running cloud mirror daemon: pushes local wiki deltas to the configured Bench ingest endpoint.                                                                        |
| `statusline.mjs`                         | Fast (<100ms) filesystem-based status string for Claude Code's `statusLine` command. Never invokes the openclaw CLI.                                                       |
| `ai.openclaw.wiki-mirror.plist.template` | LaunchAgent template for `cloud-mirror.mjs`.                                                                                                                               |

The MCP server imports `@modelcontextprotocol/sdk` and `zod` from an OpenClaw-owned dependency tree. The installer discovers and validates the active OpenClaw runtime through `OPENCLAW_BIN`, `PATH`, or supported global package-manager roots, falling back to the package it is running from. It stages a `node_modules` link beside `serve.mjs`; it does not download a second dependency tree or hardcode a Homebrew/npm prefix.

## Why not a real OpenClaw extension?

This directory previously contained TypeScript source (`index.ts`, `api.ts`, `src/*.ts`) + `openclaw.plugin.json` + `package.json`, intending to ship through the fork's `tsdown` build pipeline as a proper `definePluginEntry` extension. That approach was abandoned because:

1. **Disk pressure.** The fork's unified build stages multi-arch native binary dependencies for every plugin, which can exceed small local dev volumes.
2. **Chunk-hash coupling.** A built extension `index.js` references sibling chunks (e.g., `plugin-entry-XXXX.js`) whose hash changes between builds. The fork's dist and the homebrew install dir have different hashes, so an extension built in the fork can't be dropped into the install dir without rebuilding both in sync.
3. **Phase A scope didn't need plugin SDK features.** We never called `registerGatewayMethod`, `registerMemoryCorpusSupplement`, or `registerMemoryPromptSupplement`. All the bridge needed was a CLI subcommand + MCP stdio server — both standalone-friendly.

If/when this bridge graduates to a proper extension (e.g., for upstream PR or productization), bring back the TypeScript scaffold. Until then, keep the standalone pattern.

## Deployment

- **Installer**: `pnpm bridge:install` from a checkout, or `node scripts/install-claude-code-bridge.mjs` from the npm package. It stages stable copies under `~/.openclaw/claude-code-bridge/`.
- **Runtime dependencies**: the staged `node_modules` link points at a validated OpenClaw package, and the installer runs an import-only tool-list probe before changing Claude settings. Probe/copy failure removes a fresh link or restores the prior link. A real pre-existing `node_modules` directory is preserved when it resolves the required imports and rejected (never deleted) when it does not.
- **MCP registration**: user-scope Claude Code config, added via `claude mcp add openclaw --scope user -- node ~/.openclaw/claude-code-bridge/serve.mjs`.
- **Session start**: `~/.claude/settings.json` → `hooks.SessionStart` runs `~/.openclaw/claude-code-bridge/session-bootstrap.mjs`.
- **Statusline**: `~/.claude/settings.json` → `statusLine.command` runs `~/.openclaw/claude-code-bridge/statusline.mjs`.
- **Claude memory mirror**: `~/Library/LaunchAgents/ai.openclaw.claude-code-mirror.plist` runs `~/.openclaw/claude-code-bridge/claude-code-mirror.mjs` every 15 minutes, plus once at load.
- **Cloud mirror schedule**: `~/Library/LaunchAgents/ai.openclaw.wiki-mirror.plist` from the template in this directory.

The package manifest includes `extensions/claude-code-bridge/` and `scripts/install-claude-code-bridge.mjs` so distribution artifacts can install the same bridge without depending on a local checkout path.

## Tool surface (10 tools)

All prefixed `openclaw_`:

| Tool                | Wraps                                                                                  |
| ------------------- | -------------------------------------------------------------------------------------- |
| `gateway_health`    | `GET http://127.0.0.1:18789/healthz`                                                   |
| `agent_list`        | gateway `agents.list` (plural — `agent.list` does not exist)                           |
| `skill_list`        | gateway `skills.status`                                                                |
| `wiki_search`       | gateway `wiki.search`                                                                  |
| `wiki_get`          | gateway `wiki.get`                                                                     |
| `wiki_inbox_append` | direct filesystem append to the active wiki vault inbox (60 s dedup window)            |
| `wiki_status`       | gateway `wiki.status`                                                                  |
| `agent_handoff`     | gateway `sessions.create` (new session + initial brief, with heartbeat-window warning) |
| `agent_send`        | gateway `sessions.send` (follow-up to existing sessionKey)                             |
| `agent_messages`    | gateway `chat.history` (param is `sessionKey` not `key`)                               |

## Operational gotchas

- `openclaw gateway call` defaults its `--timeout` to 10000 ms — pass `--timeout` explicitly or calls >10 s fail with a misleading "gateway timeout" error.
- `openclaw gateway call` takes ~5–20 s per invocation (process spawn + auth + call). Do not use in fast-rendering paths like the statusline.
- Setting `OPENCLAW_GATEWAY_URL` in the openclaw child's env puts it into "URL override" mode that requires explicit `--token`. The bridge strips the env var before spawning openclaw. Keep it in the MCP server's own env only for the `/healthz` fetch.
- The wiki indexer walks the filesystem directly (`extensions/memory-wiki/src/query.ts`), so mirror files in `sources/` are searchable without registering them in `source-sync.json`. Using a distinct prefix (`claude-code-*` vs `bridge-*`) keeps them safe from the agent-bridge prune step.
- The Claude memory mirror is origin-scoped. Each user/machine writes a stable `originId` prefix and prunes only its own pages, so multiple machines can converge through the shared git-backed vault without deleting each other's memory pages.
- Codex has its own native hook surface; this installer only writes Claude Code settings. On Codex surfaces, keep the working directory inside an OpenClaw workspace with `AGENTS.md`, and file durable facts through the OpenClaw vault/wiki or inbox rather than Codex-only transcripts.
