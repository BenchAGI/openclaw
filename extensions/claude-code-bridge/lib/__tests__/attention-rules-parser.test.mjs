// Unit tests for the attention-rules parser + pattern matcher.
// Uses node:test (built into Node 18+). No fixture files on disk —
// every test stages its own markdown via fs.writeFile to a tmpdir.

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  parseSynthesisMarkdown,
  parseAttentionYaml,
  classifyByPatterns,
  loadLatestSynthesis,
  findLatestSynthesisFile,
  _resetSynthesisCache,
} from "../attention-rules-parser.mjs";

const VALID_YAML = `\
schema_version: 1
sender_tiers:
  critical:
    - "^jim@benchagi\\\\.com$"
    - "^jory@benchagi\\\\.com$"
  actionable:
    - "@benchagi\\\\.com$"
  fyi:
    - "no-reply@"
  noise:
    - "newsletter@"
keyword_tiers:
  critical:
    - "URGENT"
    - "production down"
  actionable:
    - "review"
    - "PR"
  fyi:
    - "newsletter"
  noise:
    - "unsubscribe"
project_tags:
  - tag: anvil-handoff
    keywords:
      - anvil
      - hammer
    severity: actionable
  - tag: bench-launch
    keywords:
      - mainnet
      - token
    severity: critical
escalation_rules:
  idle_thread_days_threshold: 2
  unread_count_critical: 5
confidence_threshold: 0.7
notes: |
  Free-form context goes here.
  Multiple lines fine.
`;

function wrap(yaml) {
  return `# Attention Rules\n\nSome prose.\n\n\`\`\`yaml\n${yaml}\n\`\`\`\n\nMore prose.\n`;
}

async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "attention-rules-test-"));
}

void test("parseAttentionYaml — valid synthesis parses correctly", () => {
  const out = parseAttentionYaml(VALID_YAML);
  assert.equal(out.schema_version, 1);
  assert.deepEqual(out.sender_tiers.critical, ["^jim@benchagi\\.com$", "^jory@benchagi\\.com$"]);
  assert.deepEqual(out.keyword_tiers.critical, ["URGENT", "production down"]);
  assert.equal(out.project_tags.length, 2);
  assert.equal(out.project_tags[0].tag, "anvil-handoff");
  assert.deepEqual(out.project_tags[0].keywords, ["anvil", "hammer"]);
  assert.equal(out.project_tags[0].severity, "actionable");
  assert.equal(out.escalation_rules.idle_thread_days_threshold, 2);
  assert.equal(out.confidence_threshold, 0.7);
  assert.match(out.notes, /Free-form context/);
});

void test("parseSynthesisMarkdown — extracts fenced YAML", () => {
  const md = wrap(VALID_YAML);
  const out = parseSynthesisMarkdown(md);
  assert.ok(out, "expected non-null result");
  assert.equal(out.schema_version, 1);
});

void test("parseSynthesisMarkdown — no YAML block returns null", () => {
  const md = "# Just a markdown file\n\nNo yaml here.\n";
  assert.equal(parseSynthesisMarkdown(md), null);
});

void test("parseSynthesisMarkdown — malformed YAML returns null gracefully", () => {
  const md = "```yaml\nthis is not: : valid: yaml: lol\n  - random\n :\n```\n";
  // Must not throw; either parses partial garbage or returns null.
  // The contract is "doesn't crash"; null is the safe path.
  let result;
  assert.doesNotThrow(() => {
    result = parseSynthesisMarkdown(md);
  });
  // Accept either null or an object — the loader will treat malformed
  // shapes as missing rules (no sender_tiers/keyword_tiers).
  if (result !== null) {
    // structural guard: required keys must be absent or empty
    const hasUsableTiers = result.sender_tiers && Object.keys(result.sender_tiers).length > 0;
    assert.equal(hasUsableTiers, false, "malformed yaml must not yield usable tiers");
  }
});

void test("classifyByPatterns — clear sender hit on critical", () => {
  const rules = parseAttentionYaml(VALID_YAML);
  const result = classifyByPatterns(
    {
      from: "jim@benchagi.com",
      subject: "Hey",
      snippet: "Random message",
    },
    rules,
  );
  assert.ok(result, "expected match");
  assert.equal(result.severity, "critical");
  assert.ok(result.confidence >= 0.85);
  assert.match(result.reason, /sender matches critical/);
});

void test("classifyByPatterns — keyword-only hit when sender unknown", () => {
  const rules = parseAttentionYaml(VALID_YAML);
  const result = classifyByPatterns(
    {
      from: "stranger@example.com",
      subject: "URGENT: please look",
      snippet: "Check this",
    },
    rules,
  );
  assert.ok(result, "expected match");
  assert.equal(result.severity, "critical");
});

void test("classifyByPatterns — no matches returns null (escalate)", () => {
  const rules = parseAttentionYaml(VALID_YAML);
  const result = classifyByPatterns(
    {
      from: "stranger@example.com",
      subject: "Just saying hi",
      snippet: "Random unrelated content",
    },
    rules,
  );
  assert.equal(result, null);
});

void test("classifyByPatterns — jim@benchagi.com is critical regardless of keywords", () => {
  const rules = parseAttentionYaml(VALID_YAML);
  const result = classifyByPatterns(
    {
      from: "jim@benchagi.com",
      subject: "newsletter — weekly digest",
      snippet: "unsubscribe at the bottom",
    },
    rules,
  );
  assert.ok(result);
  assert.equal(result.severity, "critical");
});

void test("classifyByPatterns — project tag bumps severity", () => {
  const rules = parseAttentionYaml(VALID_YAML);
  const result = classifyByPatterns(
    {
      from: "stranger@example.com",
      subject: "thoughts on mainnet token launch",
      snippet: "wanted to share",
    },
    rules,
  );
  assert.ok(result);
  assert.equal(result.severity, "critical");
  assert.match(result.reason, /bench-launch/);
});

void test("classifyByPatterns — sender + keyword agreement gives high confidence", () => {
  const rules = parseAttentionYaml(VALID_YAML);
  const result = classifyByPatterns(
    {
      from: "jim@benchagi.com",
      subject: "URGENT review needed",
      snippet: "production down",
    },
    rules,
  );
  assert.ok(result);
  assert.equal(result.severity, "critical");
  assert.equal(result.confidence, 0.95);
});

void test("findLatestSynthesisFile — picks newest by name sort", async () => {
  const dir = await tmpDir();
  const older = path.join(dir, "synthesis__bailey__cory-attention-rules-2026-04-26.md");
  const newer = path.join(dir, "synthesis__bailey__cory-attention-rules-2026-04-28.md");
  const decoy = path.join(dir, "synthesis__bailey__other-2026-04-29.md");
  await fs.writeFile(older, wrap(VALID_YAML), "utf8");
  await fs.writeFile(newer, wrap(VALID_YAML), "utf8");
  await fs.writeFile(decoy, "# decoy\n", "utf8");
  const found = await findLatestSynthesisFile(dir);
  assert.equal(found, newer);
});

void test("findLatestSynthesisFile — returns null when dir missing", async () => {
  const result = await findLatestSynthesisFile("/nonexistent-path-for-test-zzz-12345");
  assert.equal(result, null);
});

void test("findLatestSynthesisFile — returns null when no matching files", async () => {
  const dir = await tmpDir();
  await fs.writeFile(path.join(dir, "unrelated.md"), "# nope\n", "utf8");
  const result = await findLatestSynthesisFile(dir);
  assert.equal(result, null);
});

void test("loadLatestSynthesis — round-trips through fs", async () => {
  _resetSynthesisCache();
  const dir = await tmpDir();
  const file = path.join(dir, "synthesis__bailey__cory-attention-rules-2026-04-28.md");
  await fs.writeFile(file, wrap(VALID_YAML), "utf8");
  const rules = await loadLatestSynthesis({ dir });
  assert.ok(rules);
  assert.equal(rules.schema_version, 1);
  assert.equal(rules._filePath, file);
});

void test("loadLatestSynthesis — returns null for malformed and missing dirs", async () => {
  _resetSynthesisCache();
  const r1 = await loadLatestSynthesis({ dir: "/nonexistent-zzz-987654" });
  assert.equal(r1, null);

  const dir = await tmpDir();
  const file = path.join(dir, "synthesis__bailey__cory-attention-rules-2026-04-28.md");
  await fs.writeFile(file, "# no yaml here\n\njust prose\n", "utf8");
  _resetSynthesisCache();
  const r2 = await loadLatestSynthesis({ dir });
  assert.equal(r2, null);
});
