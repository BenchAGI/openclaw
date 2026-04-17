---
title: "Slack Home tab support — design options"
summary: "Three designs for adding app_home_opened + views.publish to the Slack extension, with a recommendation"
read_when:
  - Evaluating how to add Slack Home tab support to OpenClaw
  - Considering upstream vs fork-only shape for the feature
status: draft
authors: kestrel-crew (BenchAGI fork)
date: 2026-04-16
---

# Slack Home tab support — design options

## Context

The Slack extension today handles channel/DM messaging but does not subscribe to `app_home_opened` or call `views.publish`. Users whose Slack app has `home_tab_enabled: true` see a blank Home tab.

This design doc proposes three implementation shapes for adding Home tab support, compares them, and recommends one. **No feature code has been written yet** — this is the pre-implementation review.

Upstream target: we intend to eventually open a PR against `openclaw/openclaw`; the fork at `BenchAGI/openclaw` is the working branch. The shape we pick affects whether the change is a clean upstream contribution or a Kestrel-specific diff.

## Why add it

- Slack apps with `home_tab_enabled: true` are broken without an `app_home_opened` handler — Slack fires the event, and nothing publishes a view, so users see the "This app hasn't published anything here yet" default screen.
- OpenClaw already owns the Socket Mode / HTTP listener and the `@slack/bolt` App for each Slack account. The Home tab handler belongs in the same process or it cannot share the socket (Slack limits one Socket Mode connection per app token).
- Home tab content is inherently agent-specific (e.g. "Aurelius", "Cole"). The renderer must be pluggable — OpenClaw as a platform should not own opinionated content.

## Current Slack extension architecture

Relevant for this feature:

- `extensions/slack/src/monitor/provider.ts` creates the Bolt App, calls `registerSlackMonitorEvents` to wire event handlers.
- `extensions/slack/src/monitor/events.ts` is a simple dispatcher that calls per-category registrars:
  - `registerSlackMessageEvents` — `message`, `app_mention`
  - `registerSlackReactionEvents` — `reaction_added`, `reaction_removed`
  - `registerSlackMemberEvents`, `registerSlackChannelEvents`, `registerSlackPinEvents`, `registerSlackInteractionEvents`
- Each registrar follows the same pattern: `ctx.app.event("event_name", handler)` where `ctx.app` is the Bolt App and `ctx` is a `SlackMonitorContext`.
- `ctx.app.client` is the `WebClient` — `views.publish` is available via `ctx.app.client.views.publish({...})`.
- Events flow through `authorizeAndResolveSlackSystemEventContext` to enforce allow-lists before dispatch.

Adding `app_home_opened` requires a new registrar (`registerSlackAppHomeEvents`) plus a call to it from `events.ts`. That part is not in dispute. What's in dispute is **where the home view content comes from**.

## Goals

1. Work for the Aurelius bot on Kestrel's setup (primary driver).
2. Render agent-specific content — never a generic "OpenClaw home".
3. Degrade honestly when data is unavailable; never fake liveness.
4. Follow OpenClaw's existing extensibility patterns so the PR upstream is plausible.
5. Deterministic, side-effect-free rendering in the core; I/O in the renderer.

## Non-goals for this doc

- Block Kit templates / content library.
- Analytics or instrumentation on the Home tab itself.
- Interactive Block Kit actions (buttons, selects) in the Home tab — those are a later phase.

## Option A — Config-module path

**Shape.** The Slack account config gets a new optional block:

```jsonc
{
  "channels": {
    "slack": {
      "homeTab": {
        "enabled": true,
        "rendererModule": "./home.mjs",
        "cacheTtlSeconds": 60
      }
    }
  }
}
```

At startup OpenClaw resolves the module path (relative to the workspace root) and dynamic-imports it. The module exports:

```typescript
export async function renderHome(input: HomeRenderInput): Promise<HomeRenderResult> {
  return { blocks: [...], privateMetadata: "..." };
}
```

`HomeRenderInput` carries: Slack user id, workspace/team info, account id, `fetchedAt`, and an opaque context bag. OpenClaw does the `views.publish` call.

**Pros**
- Smallest diff: one new file (`events/app-home.ts`), one config-schema addition, one resolver utility. No new plugin hooks.
- Fastest to ship and easiest to review upstream.
- Trivial testing: snapshot the blocks array returned by the renderer.

**Cons**
- Module must be resolvable from the OpenClaw runtime's cwd. Workspace-relative paths are fiddly when OpenClaw is installed globally.
- No lifecycle hooks — the renderer can't `onInit` (e.g. prewarm a cache) or react to account reloads.
- Only one renderer per account — can't compose multiple content sources without a meta-renderer.

**Upstream viability.** High. This mirrors how OpenClaw already allows config-level callbacks for skills and slash-command handlers.

## Option B — Plugin SDK hook

**Shape.** Extend the plugin SDK hook types with a new hook name, e.g. `slack_home_opened`. Kestrel writes a standalone OpenClaw plugin (in its own repo) that registers for the hook:

```typescript
// kestrel-slack-home plugin
export default definePlugin({
  id: "kestrel-slack-home",
  hooks: {
    slack_home_opened: async ({ slackUserId, accountId, ctx }) => {
      return { blocks: [...] };
    },
  },
});
```

OpenClaw's Slack extension, on `app_home_opened`, invokes the registered hooks via the existing plugin runtime; the first plugin to return blocks wins (or they compose — TBD).

**Pros**
- Matches OpenClaw's plugin architecture — plugins can now extend Slack beyond what the bundled extension knows.
- Plugins are independently versioned and installed; no user-side config surgery needed for our Aurelius renderer.
- Opens a door: other Home tab use-cases (status dashboards, ops overviews) can be separate plugins.

**Cons**
- Bigger upstream diff: touches `plugin-sdk/src/plugins/types.d.ts`, `registry.d.ts`, `api-builder.d.ts`, plus the Slack extension.
- Hook invocation/ordering rules need design — first-wins vs aggregated vs configurable priority.
- Testing surface grows (plugin registration + hook dispatch + fallback path).

**Upstream viability.** Medium-high if we are willing to carry the PR through an SDK review. Maintainers may reasonably ask for multiple channel hooks at once (e.g. `slack_interaction_opened`, `discord_home_opened`, etc.) rather than one Slack-specific hook.

## Option C — HTTP webhook

**Shape.** Config points to a webhook URL:

```jsonc
{
  "channels": {
    "slack": {
      "homeTab": {
        "enabled": true,
        "webhookUrl": "https://benchagi.com/api/slack/home",
        "sharedSecret": "env:SLACK_HOME_SECRET",
        "timeoutMs": 3000
      }
    }
  }
}
```

On `app_home_opened`, OpenClaw POSTs the event payload to `webhookUrl` with an HMAC signature, expects `{ blocks: [...] }` back, and calls `views.publish`.

**Pros**
- Language-agnostic. Kestrel can host the renderer on its Next.js / Firebase Functions stack and reuse its existing Firestore access / identity resolution.
- Complete decoupling from OpenClaw lifecycle.
- Easy to iterate on renderer without rebuilding / reinstalling OpenClaw.

**Cons**
- Extra network hop on every Home tab open — measurable latency vs in-process rendering.
- Authentication design needed (HMAC, rotating secrets, rate limits).
- Failure modes: webhook down, slow, returns malformed blocks. Need a clear fallback view.
- Potential PII egress. The payload includes Slack user ids and channel info; surfacing that outside the OpenClaw process may raise compliance questions.

**Upstream viability.** Medium. A generic "webhook-on-home-opened" feature is coherent, but upstream may prefer a more general "event webhooks" surface so Slack isn't special.

## Comparison

| Criterion | A: Config-module | B: Plugin hook | C: HTTP webhook |
|---|---|---|---|
| Upstream-PR-ready | Yes | Yes, bigger diff | Yes, but generalization asks likely |
| Time to working Aurelius home | ~1 day | ~2-3 days | ~1-2 days |
| Latency at open | In-process (fast) | In-process (fast) | +network RTT |
| Coupling to OpenClaw runtime | Module contract | Plugin SDK contract | HTTP + signature contract |
| Blast radius on regression | Local to account | Plugin isolation | Webhook owner isolated |
| Reuse of Kestrel's web identity | Module must re-implement | Plugin must re-implement | Native — already lives in web app |
| Reuse of Phase 1 PR builders | Yes, import as a package | Yes | Yes |
| Fits OpenClaw's existing patterns | Closest (mirrors skills/slash) | Cleanest architecturally | Novel surface |

## Recommendation

**Start with Option A (config-module path), written so the internals are trivially promotable to Option B later.**

Reasoning:
- A gets Aurelius's Home tab live in ~1 day of focused work.
- The renderer contract (`renderHome(input): Promise<HomeRenderResult>`) is the same shape we'd use for a plugin hook. Promoting to B later means moving the registration point from config-path to plugin registry, not rewriting the renderer.
- Option C is genuinely attractive for Kestrel (reuse of web-app identity) but is a larger architectural commitment and has a PII-egress conversation we don't need to have today.

### Phased plan under this recommendation

**Phase A1 — OpenClaw fork changes (this repo, `feat/slack-home-tab` branch):**
1. Add `HomeTabConfig` to the Slack channel config schema (config-schema.ts / zod-schema.ts).
2. New file `extensions/slack/src/monitor/events/app-home.ts`: registrar + handler.
3. Update `extensions/slack/src/monitor/events.ts` to call the new registrar.
4. Add `ctx.homeTab` to `SlackMonitorContext` with a resolved `render` callback.
5. Add an in-process cache (LRU + TTL) keyed by `${accountId}:${slackUserId}`.
6. Error path: render a documented fallback "home temporarily unavailable" view; never crash the event loop.
7. Tests following the existing `events/reactions.test.ts` style — Bolt mocked, `views.publish` spy.
8. Docs: update `docs/channels/slack.md` with a Home tab section and a reference config.

**Phase A2 — Kestrel renderer (separate repo / BenchAGI mono repo):**
1. Publish a `renderHome` module that wraps the builders from the Phase 1 PR (`packages/slack-kit/src/home/`).
2. Resolve identity via existing `resolveSlackIdentity` against Bench Firestore.
3. Wire into Aurelius's OpenClaw workspace config at `~/clawd/kestrel-crew/kestrel-aurelius/.openclaw/config.json5`.

**Phase A3 — Install + verify:**
1. Build the fork (`pnpm build` / whatever the OpenClaw build command is — TBD, needs a look at root package.json).
2. Install the built fork globally, replacing the Homebrew-installed version.
3. Restart the Aurelius OpenClaw instance.
4. Manual Slack test: open the Home tab for one user per role tier.

**Phase B (optional, later):**
Promote the `renderHome` contract to a plugin SDK hook (`slack_home_opened` or a more general `channel_home_opened`). Ship upstream as a follow-up PR.

## Open questions for review

1. **Installation path of the built fork.** Replacing `/opt/homebrew/lib/node_modules/openclaw/` directly is fragile; a better path is `npm link` from the fork or installing a local tarball. Needs confirmation.
2. **Workspace vs global module resolution.** When OpenClaw dynamic-imports the renderer module, should the path be resolved relative to the workspace (`.openclaw/` dir) or to process cwd? Precedent: check how `providers.*.module` is resolved.
3. **Per-account vs per-agent branding.** Each Kestrel agent runs its own OpenClaw workspace, so per-account is naturally per-agent. But if a workspace ever serves multiple agents, we'd need an agent-id in the `HomeRenderInput`. Flag for future scope.
4. **Caching invalidation.** TTL-only for Phase A1. No event-driven invalidation on identity/config changes. Revisit if stale-view complaints arise.
5. **Block-budget trim.** Slack caps Home views at 100 blocks. OpenClaw or renderer? Propose: renderer owns the content budget; OpenClaw enforces a hard 100 cap as a backstop.

## What is NOT in this doc

- The actual `renderHome` contract shape (will be finalized when we pick a shape).
- Testing harness specifics for the renderer itself (Kestrel-side concern).
- Upstream PR messaging / author attribution.

## Next action

Reader picks one of: approve Option A recommendation, choose B or C explicitly, or ask for clarification before we write any feature code.
