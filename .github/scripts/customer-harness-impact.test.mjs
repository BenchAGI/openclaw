import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { validImpact } from "./customer-harness-impact.fixture.mjs";
import {
  classifyHarnessPaths,
  fetchPullRequestFiles,
  validatePullRequestHarnessImpact,
} from "./customer-harness-impact.mjs";

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "harness-impact-cli-"));
after(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

function body({ impact = "Yes", contract = validImpact } = {}) {
  const marker = contract ? `<!-- bench:customer-harness\n${JSON.stringify(contract)}\n-->` : "";
  return `## Customer delivery\n\n- Customer harness impact: ${impact}\n\n${marker}`;
}

test("prototypes the path classifier against five recent real reliability changes", () => {
  const cases = [
    {
      ref: "BenchAGI/aurelius#37",
      repository: "BenchAGI/aurelius",
      files: [
        "skills/slack-comprehension/agent/claude-agent-sdk/agent/reliable_turn_shadow.py",
        "skills/slack-comprehension/agent/claude-agent-sdk/tests/test_reliable_turn_shadow.py",
      ],
      expected: ["slack-sidecar"],
    },
    {
      ref: "BenchAGI/BenchAGI_Mono_Repo#4682",
      repository: "BenchAGI/BenchAGI_Mono_Repo",
      files: [
        "scripts/fleet/fleet-health-detector.mjs",
        "scripts/fleet/lib/fleet-health-classifier.mjs",
      ],
      expected: [],
    },
    {
      ref: "BenchAGI/BenchAGI_Mono_Repo#4683",
      repository: "BenchAGI/BenchAGI_Mono_Repo",
      files: [
        "tools/aurelius-seat-kit/scripts/relay-watchdog.mjs",
        "tools/aurelius-seat-kit/tests/relay-watchdog.test.mjs",
      ],
      expected: ["seat-kit"],
    },
    {
      ref: "BenchAGI/BenchAGI_Mono_Repo#4684",
      repository: "BenchAGI/BenchAGI_Mono_Repo",
      files: [
        "apps/relay/relay-v3.mjs",
        "apps/relay/__tests__/relay-v3-self-repair-policy.test.ts",
        "apps/web/src/lib/relay-onboarding/server.ts",
      ],
      expected: ["relay"],
    },
    {
      ref: "BenchAGI/bench-harness#191",
      repository: "BenchAGI/bench-harness",
      files: [
        "README.md",
        "bootstrap.sh",
        "scripts/agent-git-identity.sh",
        "scripts/agent-git-identity.test.sh",
      ],
      expected: ["seat-kit"],
    },
  ];
  for (const item of cases) {
    assert.deepEqual(classifyHarnessPaths(item).components, item.expected, item.ref);
  }
});

test("covers published OpenClaw runtime inputs and shipped Markdown templates", () => {
  for (const file of [
    "openclaw.mjs",
    "package.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "extensions/memory-durability/index.ts",
    "skills/healthcheck/SKILL.md",
    "scripts/postinstall-bundled-plugins.mjs",
    "scripts/openclaw-prepack.ts",
    "scripts/ui.js",
    "src/agents/templates/HEARTBEAT.md",
    "ui/src/ui.ts",
    "ui/package.json",
  ]) {
    assert.deepEqual(
      classifyHarnessPaths({
        repository: "BenchAGI/openclaw",
        files: [file],
      }).components,
      ["openclaw"],
      file,
    );
  }
});

test("rejects syntactically valid non-object contracts without crashing", () => {
  for (const contract of [null, false, 0, "", [], "invalid"]) {
    const result = validatePullRequestHarnessImpact({
      repository: "BenchAGI/openclaw",
      body: `## Customer delivery\n\n- Customer harness impact: Yes\n\n<!-- bench:customer-harness\n${JSON.stringify(contract)}\n-->`,
      files: ["src/gateway/server.ts"],
    });
    assert.equal(result.valid, false, JSON.stringify(contract));
    assert.match(result.errors.join("\n"), /contract must be an object/, JSON.stringify(contract));
  }
});

test("classifies both sides of a rename away from a runtime path", () => {
  const result = classifyHarnessPaths({
    repository: "BenchAGI/openclaw",
    files: [
      {
        filename: "docs/retired-runtime.md",
        previous_filename: "src/agents/retired-runtime.ts",
      },
    ],
  });
  assert.deepEqual(result.components, ["openclaw"]);
  assert.deepEqual(result.matchedFiles, ["src/agents/retired-runtime.ts"]);
});

test("requires Yes and a complete contract for customer-installed paths", () => {
  const result = validatePullRequestHarnessImpact({
    repository: "BenchAGI/BenchAGI_Mono_Repo",
    body: body({ impact: "No", contract: null }),
    files: ["apps/relay/relay-v3.mjs"],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /require Customer harness impact: Yes/);
});

test("requires the contract to cover every detected runtime component", () => {
  const result = validatePullRequestHarnessImpact({
    repository: "BenchAGI/BenchAGI_Mono_Repo",
    body: body(),
    files: ["tools/aurelius-seat-kit/scripts/relay-watchdog.mjs"],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /detected component seat-kit/);
});

test("allows an explicit No for control-plane-only fleet detection", () => {
  const result = validatePullRequestHarnessImpact({
    repository: "BenchAGI/BenchAGI_Mono_Repo",
    body: body({ impact: "No", contract: null }),
    files: ["scripts/fleet/fleet-health-detector.mjs"],
  });
  assert.equal(result.valid, true);
  assert.deepEqual(result.detectedComponents, []);
});

test("does not break an older control-plane-only PR that predates the declaration", () => {
  const result = validatePullRequestHarnessImpact({
    repository: "BenchAGI/BenchAGI_Mono_Repo",
    body: "## Summary\n\nRead-only fleet reporting.",
    files: ["scripts/fleet/fleet-health-detector.mjs"],
  });
  assert.equal(result.valid, true);
  assert.equal(result.impact, false);
});

test("fetches every paginated PR file before classification", async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return {
      ok: true,
      status: 200,
      json: async () =>
        page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ filename: `docs/${index}.md` }))
          : [{ filename: "apps/relay/relay-v3.mjs" }],
    };
  };
  const files = await fetchPullRequestFiles({
    repository: "BenchAGI/BenchAGI_Mono_Repo",
    pullNumber: 4910,
    token: "test-token",
    fetchImpl,
  });
  assert.equal(calls.length, 2);
  assert.equal(files.at(-1).filename, "apps/relay/relay-v3.mjs");
});

test("executes the impact gate through a symlinked CLI path", () => {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const script = path.join(currentDirectory, "customer-harness-impact.mjs");
  const symlink = path.join(testDirectory, "impact.mjs");
  fs.symlinkSync(script, symlink);
  const result = spawnSync(process.execPath, [symlink], {
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_EVENT_NAME: "unsupported-test-event",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only supports pull_request, pull_request_target, or merge_group/);
});
