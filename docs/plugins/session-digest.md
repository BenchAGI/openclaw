---
summary: "Session Digest plugin: workspace-local session_end digests for external memory reconciliation"
title: "Session Digest plugin"
read_when:
  - You want a local JSONL stream of completed OpenClaw sessions
  - You are feeding agent workspace sessions into an external reconciler
  - You need to understand what the session-digest plugin captures and skips
---

`session-digest` is an optional bundled plugin that writes one structured
digest when an OpenClaw session ends. It is intended for local workspace
reconcilers that turn completed sessions into durable memory, reports, or
follow-up queues.

The plugin only captures. It does not classify goals, promote memories, run a
reconciler, upload data, or change the active conversation.

## Enable

Enable the bundled plugin and restart the Gateway so its `session_end` hook is
registered:

```bash
openclaw plugins enable session-digest
openclaw gateway restart
```

Equivalent config:

```json5
{
  plugins: {
    entries: {
      "session-digest": {
        enabled: true,
      },
    },
  },
}
```

If your config uses `plugins.allow`, include `session-digest` in the allowlist.

## Output

By default, digests are written under the owning agent workspace:

```text
<agent-workspace>/state/session-digests/session-digests.jsonl
<agent-workspace>/state/session-digests/by-session/<sessionId>.json
```

Each JSONL row includes the session id, agent id, start/end timestamps when
available, a redacted intent, basic entities such as the end reason, source
transcript reference, and `privacy: "local-private"`.

The plugin does not copy the transcript into the digest. When
`captureIntent` is enabled, it reads only a bounded head of the transcript and
uses the first non-meta user message as the intent. Missing or archived
transcripts produce a stub digest with an empty intent.

## Configuration

Set options under `plugins.entries.session-digest.config`:

| Key             | Default                   | Meaning                                                                                   |
| --------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `digestDir`     | `"state/session-digests"` | Output directory relative to the agent workspace. Parent and absolute paths are rejected. |
| `captureIntent` | `true`                    | Read the transcript head to capture a redacted first user intent.                         |

Example:

```json5
{
  plugins: {
    entries: {
      "session-digest": {
        enabled: true,
        config: {
          digestDir: "state/session-digests",
          captureIntent: true,
        },
      },
    },
  },
}
```

## Capture Rules

The plugin writes a digest when the Gateway emits `session_end` for reasons
such as idle rotation, daily rotation, reset, delete, restart, or shutdown.

It skips:

- empty sessions with `messageCount: 0`
- compaction transitions, because the conversation continues in the next
  session
- events without an agent id or resolvable workspace

One-shot CLI sessions are captured when the session later closes through idle
or daily cleanup, or during the shutdown drain.

## Verify

After enabling and restarting:

```bash
openclaw plugins inspect session-digest --runtime --json
```

Then end a non-empty session and check the workspace output:

```bash
tail -n 1 <agent-workspace>/state/session-digests/session-digests.jsonl
```

## Related

- [Plugins](/tools/plugin)
- [Hooks](/plugins/hooks)
- [Memory wiki](/plugins/memory-wiki)
