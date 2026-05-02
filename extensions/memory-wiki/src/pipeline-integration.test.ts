import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { compileMemoryWikiVault } from "./compile.js";
import { lintMemoryWikiVault } from "./lint.js";
import { renderWikiMarkdown } from "./markdown.js";
import { repairMemoryWikiVault } from "./structure-repair.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

function writePage(rootDir: string, relativePath: string, content: string) {
  return fs.writeFile(path.join(rootDir, relativePath), content, "utf8");
}

describe("wiki pipeline integration (end-to-end repair + lint)", () => {
  it("reduces lint issues after compile+repair on a vault with mixed legacy content", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-integration-",
      config: { vault: { renderMode: "native" } },
      initialize: true,
    });

    // 1) Human-authored concept with `kind: protocol` but none of the canonical fields.
    await writePage(
      rootDir,
      "concepts/dreaming-protocol.md",
      "---\nkind: protocol\nstatus: canonical\n---\n\n# Dreaming Protocol\n\nBody text.\n",
    );

    // 2) Bridge source with transcript containing [[reply_to_current]] inside a code fence
    //    — historically caused 200+ false-positive broken-wikilink warnings.
    await writePage(
      rootDir,
      "sources/bridge-transcript.md",
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge.transcript",
          title: "Bridge Transcript",
          sourceType: "memory-bridge",
          sourcePath: "/tmp/t.md",
          bridgeRelativePath: "memory/t.md",
          bridgeWorkspaceDir: "/tmp",
          updatedAt: new Date().toISOString(),
        },
        body: [
          "# Bridge Transcript",
          "",
          "## Content",
          "```markdown",
          "assistant: [[reply_to_current]] hello there",
          "user: [[another_template_token]] response",
          "```",
          "",
        ].join("\n"),
      }),
    );

    // 3) Orphan shell (historically created by compile's related-block writer on empty files).
    await writePage(
      rootDir,
      "sources/orphan-shell.md",
      "## Related\n<!-- openclaw:wiki:related:start -->\n- No related pages yet.\n<!-- openclaw:wiki:related:end -->\n",
    );

    // 4) A dashboard-style page with native-mode link referencing another page — must resolve.
    await writePage(
      rootDir,
      "sources/cross-link.md",
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.cross-link",
          title: "Cross Link",
          sourceType: "local-file",
          sourcePath: "/tmp/xl.md",
          updatedAt: new Date().toISOString(),
        },
        body: "# Cross Link\n\nSee [Bridge Transcript](sources/bridge-transcript.md) for context.\n",
      }),
    );

    // --- Run the pipeline as an operator would ---
    const repairResult = await repairMemoryWikiVault(config, { removeOrphans: true });
    expect(repairResult.orphansRemoved).toBe(1);
    expect(repairResult.backfilled).toBeGreaterThanOrEqual(1);

    await compileMemoryWikiVault(config);
    const lintResult = await lintMemoryWikiVault(config);

    const errors = lintResult.issues.filter((issue) => issue.severity === "error");
    const brokenLinks = lintResult.issues.filter((issue) => issue.code === "broken-wikilink");
    const missingId = lintResult.issues.filter((issue) => issue.code === "missing-id");
    const missingPageType = lintResult.issues.filter((issue) => issue.code === "missing-page-type");

    expect(errors).toHaveLength(0);
    expect(missingId).toHaveLength(0);
    expect(missingPageType).toHaveLength(0);
    expect(brokenLinks).toHaveLength(0);

    // Orphan is gone.
    await expect(
      fs.stat(path.join(rootDir, "sources", "orphan-shell.md")).then(
        () => true,
        () => false,
      ),
    ).resolves.toBe(false);

    // Concept got canonicalized.
    const conceptRaw = await fs.readFile(
      path.join(rootDir, "concepts", "dreaming-protocol.md"),
      "utf8",
    );
    expect(conceptRaw).toMatch(/\nid: concept\.dreaming-protocol\n/);
    expect(conceptRaw).toMatch(/\npageType: concept\n/);
    expect(conceptRaw).toMatch(/\nupdatedAt: /);
    expect(conceptRaw).toContain("# Dreaming Protocol");
    // Human-authored `kind: protocol` was preserved.
    expect(conceptRaw).toMatch(/\nkind: protocol\n/);
  });

  it("compile alone (without repair) also self-heals structure for non-orphan pages", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-integration-compile-",
      config: { vault: { renderMode: "native" } },
      initialize: true,
    });
    await writePage(rootDir, "concepts/mostly-bare.md", "# Mostly Bare\n\nSome human text.\n");

    await compileMemoryWikiVault(config);

    const raw = await fs.readFile(path.join(rootDir, "concepts", "mostly-bare.md"), "utf8");
    expect(raw).toMatch(/^---\n/);
    expect(raw).toMatch(/\npageType: concept\n/);
    expect(raw).toMatch(/\nid: concept\.mostly-bare\n/);
    expect(raw).toMatch(/\nupdatedAt: /);
    expect(raw).toContain("# Mostly Bare");
  });
});
