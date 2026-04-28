import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// bench-reflective-dreaming is a scripts-runtime plugin. Real behavior lives in
// scripts/install.mjs + scripts/uninstall.mjs, which register nightly launchd
// crons for per-agent reflection, fleet canon, and consolidation.
export default definePluginEntry({
  id: "bench-reflective-dreaming",
  name: "Bench Reflective Dreaming",
  description: "Structured per-agent reflection, fleet canon, and consolidation.",
  register() {},
});
