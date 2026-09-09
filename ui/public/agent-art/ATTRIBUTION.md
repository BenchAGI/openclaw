# Agent portraits

256×256 PNG portraits of the Bench agents, downsampled with `sips -Z 256` from
the BenchAGI web app's public assets (`apps/web/public/agents/*.png` in the
BenchAGI monorepo, served on benchagi.com). They are BenchAGI product art, not
OpenClaw assets, and ship only in the Bench fork of the Control UI.

| File           | Agent                 | Source                                |
| -------------- | --------------------- | ------------------------------------- |
| `aurelius.png` | Aurelius              | `apps/web/public/agents/aurelius.png` |
| `zig.png`      | Zig (agent id `cole`) | `apps/web/public/agents/zig.png`      |
| `sage.png`     | Sage                  | `apps/web/public/agents/sage.png`     |
| `piper.png`    | Piper                 | `apps/web/public/agents/piper.png`    |
| `ember.png`    | Ember                 | `apps/web/public/agents/ember.png`    |
| `bailey.png`   | Bailey                | `apps/web/public/agents/bailey.png`   |
| `epic.png`     | Epic                  | `apps/web/public/agents/epic.png`     |

Sentinel has no portrait and renders its shield glyph instead
(`ui/src/lib/agents/bench-agent-identity.ts`).
