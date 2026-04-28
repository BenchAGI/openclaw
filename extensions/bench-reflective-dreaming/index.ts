// bench-reflective-dreaming is a scripts-runtime plugin.
// Real behavior lives in scripts/install.mjs + scripts/uninstall.mjs, which
// register nightly launchd crons for per-agent reflection, fleet canon, and
// consolidation. This file exists only to satisfy the tsdown bundler, which
// defaults to ./index.ts when a manifested plugin has no package.json.
export const PLUGIN_RUNTIME = "scripts" as const;
