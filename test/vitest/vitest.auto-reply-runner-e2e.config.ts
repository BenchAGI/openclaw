// Runs only the deterministic reply-runner integration owner in normal CI.
import { defineConfig } from "vitest/config";
import e2eConfig from "./vitest.e2e.config.ts";

export function createAutoReplyRunnerE2EVitestConfig() {
  return defineConfig({
    ...e2eConfig,
    test: {
      ...e2eConfig.test,
      name: "auto-reply-runner-e2e",
      // Keep this exact owner sealed: a broad CI include file must not opt the
      // rest of the E2E suites into a normal pull-request run.
      include: ["src/auto-reply/reply/agent-runner.runreplyagent.e2e.test.ts"],
      passWithNoTests: false,
    },
  });
}

export default createAutoReplyRunnerE2EVitestConfig();
