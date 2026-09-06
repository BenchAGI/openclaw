<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line
below this comment.

Required PR title:
type: user-facing description
Use a parenthesized scope only when it adds clarity:
fix(auth): login redirect loops when session cookie is expired

Types: feat, fix, improve, refactor, docs, chore.
For fixes, describe the user-visible symptom and trigger:
fix: task list fails to load when user has no environments
Avoid implementation details such as:
fix: add null check to task query
-->

<details>
<summary>Additional instructions</summary>

**MUST:** Keep **Allow edits from maintainers** enabled for this PR so maintainers
can help update the branch when needed.

</details>

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
For fixes, begin with:
"Fixes an issue where users <do X> would <experience Y> when <condition>."
or:
"Resolves a problem where..."

Name the affected UI surface or workflow. Do not describe the code-level cause here.
-->

## Why This Change Was Made

<!--
In one or two sentences, explain the complete shipped solution, key design
decisions, and relevant boundaries or non-goals. Include implementation detail
only when it helps reviewers understand user-visible behavior or risk.
Avoid file-by-file narration.
-->

## User Impact

<!--
State what users, operators, or developers can now do or expect. Lead with the
concrete benefit and use user-facing language. If there is no user-visible
impact, say so plainly.
-->

## Customer Harness Delivery

<!-- REQUIRED: select exactly one. OpenClaw runtime paths require Yes. -->

- Customer harness impact: <!-- Yes / No -->

<!--
If Yes, include exactly one machine-readable impact contract. Remove the
spaces in the example delimiters (`< !--` and `-- >`) when adding it.
This declaration does not publish, deploy, restart, or change a customer.
-->

```text
< !-- bench:customer-harness
{
  "version": 1,
  "components": [
    {
      "kind": "openclaw",
      "delivery": "channel-pull",
      "restart": "gateway",
      "rollback": "previous-release"
    }
  ],
  "compatibility": {
    "kind": "requires-minimum-openclaw",
    "minimumOpenClaw": "2026.7.1"
  },
  "rollout": {
    "strategy": "canary-cohorts",
    "soakMinutes": 60,
    "maxParallel": 1
  },
  "proof": {
    "kind": "no-send-turn",
    "checks": ["artifact-loaded", "gateway-rpc", "rollback-ready"]
  },
  "humanGates": ["customer-canary"]
}
-- >
```

## Evidence

<!--
Show the most useful proof that this change works. Screenshots, screencasts,
terminal output, focused tests, CI results, live observations, redacted logs,
and artifact links are all useful. Include before/after evidence for visual
changes when it clarifies the result.

Reviewers will inspect the code, tests, and CI. Use this section to make the
validation easy to understand, not to restate the diff.
-->
