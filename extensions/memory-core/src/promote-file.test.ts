import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  contentHashOf,
  detectSecrets,
  isPromotedArtifact,
  promoteFileToAgentMemory,
  promotionSlug,
  renderPromotedMemory,
  splitFrontmatter,
  writePromotedMemoryFile,
  type PromoteFileSource,
  type PromoteManagerLike,
} from "./promote-file.js";

let workspaceDir = "";

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "promote-file-"));
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

function seatMemory(name: string, body: string): PromoteFileSource {
  return {
    sourcePath: `/home/u/.claude/projects/-seat/memory/${name}.md`,
    content: `---\nname: ${name}\ndescription: "a fact"\nmetadata:\n  type: project\n  originSessionId: sess-123\n---\n${body}\n`,
    sourceSessionId: "bridge-sess-9",
    sourceAgentId: "aurelius",
    seatKind: "claude-code",
    memoryType: "project",
  };
}

describe("promotionSlug", () => {
  it("prefers the frontmatter name", () => {
    expect(promotionSlug("/x/y/whatever.md", "Harness Ops Channel")).toBe("harness-ops-channel");
  });
  it("falls back to the basename", () => {
    expect(promotionSlug("/x/y/My File.md")).toBe("my-file");
  });
  it("is traversal-safe", () => {
    const slug = promotionSlug("/x/y/z.md", "../../etc/passwd");
    expect(slug).not.toContain("/");
    expect(slug).not.toContain("..");
  });
});

describe("contentHashOf", () => {
  it("is stable across trailing whitespace and CRLF", () => {
    expect(contentHashOf("a\r\nb  \n")).toBe(contentHashOf("a\nb\n"));
  });
  it("changes when content changes", () => {
    expect(contentHashOf("a")).not.toBe(contentHashOf("b"));
  });
});

describe("detectSecrets", () => {
  it("matches secret value shapes by pattern name (never the span)", () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nMOCKKEYDATA\n-----END PRIVATE KEY-----"; // pragma: allowlist secret
    expect(detectSecrets(pem)).toContain("pem-private-key");
    expect(detectSecrets("token=sk-abcdefghijklmnopqrstuvwx")).toContain("openai-key"); // pragma: allowlist secret
  });
  it("does not flag prose that merely mentions tokens", () => {
    expect(detectSecrets("Gateway token rotation has four legs; rotate the token.")).toEqual([]);
  });
});

describe("renderPromotedMemory / isPromotedArtifact", () => {
  it("injects a promotion block into existing frontmatter and is detectable", () => {
    const src = seatMemory("alpha", "body text");
    const rendered = renderPromotedMemory(src, "promotion:\n  source: benchagi-seat-bridge");
    expect(isPromotedArtifact(rendered)).toBe(true);
    const { frontmatter, body } = splitFrontmatter(rendered);
    expect(frontmatter).toContain("name: alpha");
    expect(frontmatter).toContain("promotion:");
    expect(body).toContain("body text");
  });
  it("treats hand-authored markdown as non-artifact", () => {
    expect(isPromotedArtifact("---\nname: x\n---\nhi")).toBe(false);
    expect(isPromotedArtifact("plain note")).toBe(false);
  });
});

describe("writePromotedMemoryFile", () => {
  it("created -> unchanged -> updated, writing under memory/seat/ with provenance", async () => {
    const src = seatMemory("beta", "first");
    const created = await writePromotedMemoryFile({ workspaceDir, source: src });
    expect(created.status).toBe("created");
    expect(created.target).toBe(path.join(workspaceDir, "memory", "seat", "beta.md"));
    const written = await fs.readFile(created.target, "utf8");
    expect(written).toContain('source: "benchagi-seat-bridge"');
    expect(written).toContain("sourceHash:");
    expect(written).toContain("status: promoted");
    expect(written).toContain('sourcePath: "/home/u/.claude/projects/-seat/memory/beta.md"');
    expect(written).toContain('seatSessionId: "bridge-sess-9"');

    const again = await writePromotedMemoryFile({ workspaceDir, source: src });
    expect(again.status).toBe("unchanged");

    const edited = await writePromotedMemoryFile({
      workspaceDir,
      source: seatMemory("beta", "second body"),
    });
    expect(edited.status).toBe("updated");
    expect(await fs.readFile(edited.target, "utf8")).toContain("second body");
  });

  it("refuses to clobber a hand-authored file and preserves its bytes", async () => {
    const seatDir = path.join(workspaceDir, "memory", "seat");
    await fs.mkdir(seatDir, { recursive: true });
    const handPath = path.join(seatDir, "gamma.md");
    const handBytes = "# hand authored\n\nimportant\n";
    await fs.writeFile(handPath, handBytes);
    const result = await writePromotedMemoryFile({
      workspaceDir,
      source: seatMemory("gamma", "promoted body"),
    });
    expect(result.status).toBe("skipped-handauthored");
    expect(await fs.readFile(handPath, "utf8")).toBe(handBytes);
  });

  it("blocks promotion when a secret is present and writes no file", async () => {
    const src = seatMemory(
      "delta",
      "key: -----BEGIN PRIVATE KEY-----\nXX\n-----END PRIVATE KEY-----",
    ); // pragma: allowlist secret
    const result = await writePromotedMemoryFile({ workspaceDir, source: src });
    expect(result.status).toBe("secret-blocked");
    expect(result.reason).toContain("pem-private-key");
    expect(result.reason).not.toContain("BEGIN PRIVATE KEY");
    await expect(
      fs.access(path.join(workspaceDir, "memory", "seat", "delta.md")),
    ).rejects.toThrow();
  });

  it("suffixes the slug on a cross-source collision (never overwrites a different source)", async () => {
    const a: PromoteFileSource = {
      sourcePath: "/a/memory/dup.md",
      content: "---\nname: dup\n---\nA\n",
    };
    const b: PromoteFileSource = {
      sourcePath: "/b/memory/dup.md",
      content: "---\nname: dup\n---\nB\n",
    };
    const ra = await writePromotedMemoryFile({ workspaceDir, source: a });
    const rb = await writePromotedMemoryFile({ workspaceDir, source: b });
    expect(ra.slug).toBe("dup");
    expect(rb.slug).not.toBe("dup");
    expect(rb.target).not.toBe(ra.target);
    expect(await fs.readFile(ra.target, "utf8")).toContain("\nA");
    expect(await fs.readFile(rb.target, "utf8")).toContain("\nB");
  });
});

describe("promoteFileToAgentMemory", () => {
  function fakeManager(sync?: PromoteManagerLike["sync"]): PromoteManagerLike {
    return {
      status: () => ({ workspaceDir }),
      sync: sync ?? (async () => {}),
    };
  }

  it("syncs exactly once when something was written", async () => {
    const sync = vi.fn(async () => {});
    const summary = await promoteFileToAgentMemory({
      manager: fakeManager(sync),
      sources: [seatMemory("e1", "x"), seatMemory("e2", "y")],
    });
    expect(summary.indexed).toBe(true);
    expect(sync).toHaveBeenCalledTimes(1);
    expect(sync).toHaveBeenCalledWith({ reason: "cli-promote", force: false });
    expect(summary.results.map((r) => r.status)).toEqual(["created", "created"]);
  });

  it("does not sync when every source is unchanged", async () => {
    const src = seatMemory("e3", "x");
    await promoteFileToAgentMemory({ manager: fakeManager(), sources: [src] });
    const sync = vi.fn(async () => {});
    const summary = await promoteFileToAgentMemory({ manager: fakeManager(sync), sources: [src] });
    expect(summary.indexed).toBe(false);
    expect(sync).not.toHaveBeenCalled();
  });

  it("throws when the workspace cannot be resolved", async () => {
    const manager = { status: () => ({ workspaceDir: undefined }), sync: vi.fn() };
    await expect(
      promoteFileToAgentMemory({ manager, sources: [seatMemory("e4", "x")] }),
    ).rejects.toThrow(/resolvable workspace/);
  });
});
