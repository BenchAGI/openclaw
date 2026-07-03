// Guards the shipped anthropic manifest against the ultracode outage class:
// the fail-closed setup fallback (resolvePluginSetupCliBackend) narrows by the
// manifest's declared cli-backend ids (listSetupCliBackendIds). The plugin's
// setup runtime registers BOTH claude-cli and claude-cli-ultracode, but when
// the lazily-activated runtime registry doesn't have them, only ids declared
// in the manifest can be resolved — an undeclared claude-cli-ultracode turned
// into MissingAgentHarnessError on live gateways while base claude-cli kept
// working (2026-07-02).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadPluginManifest } from "./manifest.js";
import { listSetupCliBackendIds } from "./setup-descriptors.js";

const ANTHROPIC_EXTENSION_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../extensions/anthropic",
);

describe("shipped anthropic plugin manifest", () => {
  it("declares both claude-cli backends so the setup fallback can resolve ultracode", () => {
    const result = loadPluginManifest(ANTHROPIC_EXTENSION_DIR);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.manifest.cliBackends).toContain("claude-cli");
    expect(result.manifest.cliBackends).toContain("claude-cli-ultracode");
    // The setup fallback resolves via listSetupCliBackendIds (setup.cliBackends
    // ?? cliBackends); the shipped manifest declares no setup.cliBackends, so
    // the top-level list is the one the fallback narrows by.
    const declared = listSetupCliBackendIds({
      providers: result.manifest.providers ?? [],
      cliBackends: result.manifest.cliBackends ?? [],
    });
    expect(declared).toContain("claude-cli");
    expect(declared).toContain("claude-cli-ultracode");
  });
});
