import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function runNode(args: string[], options: { env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Claude Code bridge installer", () => {
  it("stages bridge files, settings, LaunchAgent logs, and preserves non-bridge hooks", () => {
    const home = makeTempDir("openclaw-bridge-home-");
    const openclawHome = path.join(home, ".openclaw");
    const settingsPath = path.join(home, ".claude", "settings.json");
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          hooks: {
            SessionStart: [
              { hooks: [{ type: "command", command: "echo keep" }] },
              {
                hooks: [
                  {
                    type: "command",
                    command: `${process.execPath} ${openclawHome}/claude-code-bridge/session-bootstrap.mjs`,
                  },
                ],
              },
            ],
          },
          custom: true,
        },
        null,
        2,
      ),
      "utf8",
    );

    const result = runNode([
      "scripts/install-claude-code-bridge.mjs",
      "--home",
      home,
      "--openclaw-home",
      openclawHome,
      "--node",
      process.execPath,
      "--no-load",
    ]);

    expect(result.status).toBe(0);
    expect(existsSync(path.join(openclawHome, "claude-code-bridge", "mirror.mjs"))).toBe(true);
    expect(
      existsSync(path.join(openclawHome, "claude-code-bridge", "claude-code-mirror.mjs")),
    ).toBe(true);
    expect(existsSync(path.join(openclawHome, "logs"))).toBe(true);

    const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(settings.custom).toBe(true);
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe("echo keep");
    expect(settings.hooks.SessionStart[1].hooks[0].command).toContain("session-bootstrap.mjs");
    expect(settings.statusLine.command).toContain("statusline.mjs");

    const plistPath = path.join(
      home,
      "Library",
      "LaunchAgents",
      "ai.openclaw.claude-code-mirror.plist",
    );
    const plist = readFileSync(plistPath, "utf8");
    expect(plist).toContain(path.join(openclawHome, "logs", "claude-code-mirror.log"));
    expect(plist).toContain(path.join(openclawHome, "logs", "claude-code-mirror.err.log"));
  });
});

describe("Claude Code memory mirror", () => {
  it("renders path-heavy source metadata as valid YAML scalars", () => {
    const home = makeTempDir("openclaw-bridge-home-");
    const openclawHome = path.join(home, ".openclaw");
    const projectDir = path.join(home, ".claude", "projects", "-tmp-openclaw-demo", "memory");
    const sourcePath = path.join(projectDir, "archive", "2026-06-12: bridge note.md");
    mkdirSync(path.dirname(sourcePath), { recursive: true });
    writeFileSync(sourcePath, "# Bridge note\n\nRemember the launch context.\n", "utf8");

    const result = runNode(["extensions/claude-code-bridge/mirror.mjs", "--force"], {
      env: {
        HOME: home,
        OPENCLAW_HOME: openclawHome,
        BENCH_ORIGIN_USER: "reviewer@example.com",
        BENCH_ORIGIN_MACHINE: "workstation:one",
      },
    });

    expect(result.status).toBe(0);
    const sourcesDir = path.join(openclawHome, "wiki", "main", "sources");
    const pages = readFileSync(
      path.join(
        sourcesDir,
        "claude-code-reviewer-example-com-workstation-one-tmp-openclaw-demo-archive-2026-06-12-bridge-note.md",
      ),
      "utf8",
    );
    const frontmatter = pages.split("---\n")[1];
    const parsed = parseDocument(frontmatter).toJSON();
    expect(parsed).toMatchObject({
      pageType: "source",
      sourceType: "memory-bridge",
      originId: "reviewer-example-com.workstation-one",
      sourcePath,
      bridgeRelativePath: "archive/2026-06-12: bridge note.md",
      status: "active",
    });
  });
});
