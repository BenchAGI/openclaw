import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
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

function linkDirectory(target: string, destination: string) {
  symlinkSync(target, destination, process.platform === "win32" ? "junction" : "dir");
}

function makeInstallerPackage(options: { withDependencies: boolean }) {
  const packageRoot = makeTempDir("openclaw-bridge-package-");
  mkdirSync(path.join(packageRoot, "scripts"), { recursive: true });
  mkdirSync(path.join(packageRoot, "extensions"), { recursive: true });
  writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: "test" }),
    "utf8",
  );
  writeFileSync(path.join(packageRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", "utf8");
  cpSync(
    path.resolve("scripts/install-claude-code-bridge.mjs"),
    path.join(packageRoot, "scripts", "install-claude-code-bridge.mjs"),
  );
  cpSync(
    path.resolve("extensions/claude-code-bridge"),
    path.join(packageRoot, "extensions", "claude-code-bridge"),
    { recursive: true },
  );
  if (options.withDependencies) {
    linkDirectory(path.resolve("node_modules"), path.join(packageRoot, "node_modules"));
  }
  return {
    packageRoot,
    openclawBin: path.join(packageRoot, "openclaw.mjs"),
    installerPath: path.join(packageRoot, "scripts", "install-claude-code-bridge.mjs"),
  };
}

function makeRuntimePackage() {
  const runtimeRoot = makeTempDir("openclaw-bridge-runtime-");
  writeRuntimePackage(runtimeRoot, "test-runtime");
  return runtimeRoot;
}

function writeRuntimePackage(runtimeRoot: string, version: string) {
  mkdirSync(runtimeRoot, { recursive: true });
  writeFileSync(
    path.join(runtimeRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
    "utf8",
  );
  writeFileSync(path.join(runtimeRoot, "openclaw.mjs"), "#!/usr/bin/env node\n", "utf8");
  linkDirectory(path.resolve("node_modules"), path.join(runtimeRoot, "node_modules"));
}

function makePnpmGlobalRuntime() {
  const container = makeTempDir("openclaw-bridge-pnpm-global-");
  const globalRoot = path.join(container, "global", "5", "node_modules");
  const firstStoreRoot = path.join(
    globalRoot,
    ".pnpm",
    "openclaw@test-one",
    "node_modules",
    "openclaw",
  );
  const secondStoreRoot = path.join(
    globalRoot,
    ".pnpm",
    "openclaw@test-two",
    "node_modules",
    "openclaw",
  );
  writeRuntimePackage(firstStoreRoot, "test-one");
  writeRuntimePackage(secondStoreRoot, "test-two");
  const stablePackageRoot = path.join(globalRoot, "openclaw");
  linkDirectory(firstStoreRoot, stablePackageRoot);
  return { globalRoot, stablePackageRoot, firstStoreRoot, secondStoreRoot };
}

function makeNpmRootShim(globalRoot: string) {
  const binDir = makeTempDir("openclaw-bridge-package-manager-bin-");
  const shimPath = path.join(binDir, process.platform === "win32" ? "npm.cmd" : "npm");
  const content =
    process.platform === "win32"
      ? `@echo off\r\nif "%1"=="root" echo ${globalRoot}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${globalRoot}'\n`;
  writeFileSync(shimPath, content, "utf8");
  if (process.platform !== "win32") {
    chmodSync(shimPath, 0o755);
  }
  return binDir;
}

function makeStandaloneBridgeDependencies() {
  const nodeModulesPath = makeTempDir("openclaw-bridge-previous-deps-");
  mkdirSync(path.join(nodeModulesPath, "@modelcontextprotocol"), { recursive: true });
  linkDirectory(
    path.resolve("node_modules/@modelcontextprotocol/sdk"),
    path.join(nodeModulesPath, "@modelcontextprotocol", "sdk"),
  );
  linkDirectory(path.resolve("node_modules/zod"), path.join(nodeModulesPath, "zod"));
  writeFileSync(path.join(nodeModulesPath, "operator-file"), "preserve", "utf8");
  return nodeModulesPath;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Claude Code bridge installer", () => {
  it("stages bridge files, settings, LaunchAgent logs, and preserves non-bridge hooks", () => {
    const installerPackage = makeInstallerPackage({ withDependencies: true });
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
              {
                hooks: [
                  {
                    type: "command",
                    command: `${process.execPath} C:\\Users\\bench\\.openclaw\\claude-code-bridge\\session-bootstrap.mjs`,
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

    const result = runNode(
      [
        installerPackage.installerPath,
        "--home",
        home,
        "--openclaw-home",
        openclawHome,
        "--node",
        process.execPath,
        "--no-load",
      ],
      {
        env: {
          OPENCLAW_BIN: path.join(home, "missing-openclaw"),
          BUN_INSTALL: path.join(home, "missing-bun"),
          PATH: "",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(existsSync(path.join(openclawHome, "claude-code-bridge", "mirror.mjs"))).toBe(true);
    expect(
      existsSync(path.join(openclawHome, "claude-code-bridge", "claude-code-mirror.mjs")),
    ).toBe(true);
    expect(existsSync(path.join(openclawHome, "logs"))).toBe(true);
    const dependencyPath = path.join(openclawHome, "claude-code-bridge", "node_modules");
    expect(lstatSync(dependencyPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(dependencyPath)).toBe(realpathSync(path.resolve("node_modules")));

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

  it("discovers the installed runtime and serves MCP when the source package has no dependencies", async () => {
    const installerPackage = makeInstallerPackage({ withDependencies: false });
    const runtimeRoot = makeRuntimePackage();
    const home = makeTempDir("openclaw-bridge-home-");
    const openclawHome = path.join(home, ".openclaw");
    const result = runNode(
      [
        installerPackage.installerPath,
        "--home",
        home,
        "--openclaw-home",
        openclawHome,
        "--node",
        process.execPath,
        "--no-claude-settings",
        "--no-launchd",
      ],
      { env: { OPENCLAW_BIN: path.join(runtimeRoot, "openclaw.mjs") } },
    );

    expect(result.status, result.stderr).toBe(0);
    const stagedDir = path.join(openclawHome, "claude-code-bridge");
    expect(realpathSync(path.join(stagedDir, "node_modules"))).toBe(
      realpathSync(path.join(runtimeRoot, "node_modules")),
    );

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(stagedDir, "serve.mjs")],
      env: {
        HOME: home,
        OPENCLAW_HOME: openclawHome,
        OPENCLAW_BRIDGE_AUTOSTART: "false",
        BENCH_HARNESS_MANIFEST_ENFORCE: "false",
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "openclaw-bridge-installer-test", version: "1.0.0" });
    try {
      await client.connect(transport);
      const response = await client.listTools();
      expect(response.tools).toHaveLength(10);
      expect(response.tools.map((tool) => tool.name)).toContain("openclaw_wiki_search");
    } finally {
      await client.close();
    }
  });

  it("refuses to delete an invalid pre-existing dependency directory", () => {
    const installerPackage = makeInstallerPackage({ withDependencies: true });
    const home = makeTempDir("openclaw-bridge-home-");
    const openclawHome = path.join(home, ".openclaw");
    const dependencyPath = path.join(openclawHome, "claude-code-bridge", "node_modules");
    mkdirSync(dependencyPath, { recursive: true });
    const sentinelPath = path.join(dependencyPath, "keep-me");
    writeFileSync(sentinelPath, "owned by the operator", "utf8");

    const result = runNode(
      [
        installerPackage.installerPath,
        "--home",
        home,
        "--openclaw-home",
        openclawHome,
        "--no-claude-settings",
        "--no-launchd",
      ],
      { env: { OPENCLAW_BIN: installerPackage.openclawBin } },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("staged bridge runtime verification failed");
    expect(readFileSync(sentinelPath, "utf8")).toBe("owned by the operator");
    expect(lstatSync(dependencyPath).isDirectory()).toBe(true);
  });

  it("repairs a stale dependency symlink without touching its target", () => {
    const installerPackage = makeInstallerPackage({ withDependencies: true });
    const home = makeTempDir("openclaw-bridge-home-");
    const openclawHome = path.join(home, ".openclaw");
    const dependencyPath = path.join(openclawHome, "claude-code-bridge", "node_modules");
    const staleTarget = makeTempDir("openclaw-bridge-stale-deps-");
    mkdirSync(path.dirname(dependencyPath), { recursive: true });
    writeFileSync(path.join(staleTarget, "operator-file"), "preserve", "utf8");
    linkDirectory(staleTarget, dependencyPath);

    const result = runNode(
      [
        installerPackage.installerPath,
        "--home",
        home,
        "--openclaw-home",
        openclawHome,
        "--node",
        process.execPath,
        "--no-claude-settings",
        "--no-launchd",
      ],
      { env: { OPENCLAW_BIN: installerPackage.openclawBin } },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(realpathSync(dependencyPath)).toBe(realpathSync(path.resolve("node_modules")));
    expect(readFileSync(path.join(staleTarget, "operator-file"), "utf8")).toBe("preserve");
  });

  it.each(["fresh link", "replacement link"])(
    "rolls back a %s when runtime verification fails",
    (installMode) => {
      const installerPackage = makeInstallerPackage({ withDependencies: true });
      const home = makeTempDir("openclaw-bridge-home-");
      const openclawHome = path.join(home, ".openclaw");
      const stagedDir = path.join(openclawHome, "claude-code-bridge");
      const dependencyPath = path.join(stagedDir, "node_modules");
      const previousTarget =
        installMode === "replacement link" ? makeStandaloneBridgeDependencies() : null;
      if (previousTarget) {
        mkdirSync(stagedDir, { recursive: true });
        linkDirectory(previousTarget, dependencyPath);
      }

      const result = runNode(
        [
          installerPackage.installerPath,
          "--home",
          home,
          "--openclaw-home",
          openclawHome,
          "--node",
          path.join(home, "missing-node"),
          "--no-claude-settings",
          "--no-launchd",
        ],
        { env: { OPENCLAW_BIN: installerPackage.openclawBin } },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("staged bridge runtime verification failed");
      if (previousTarget) {
        expect(realpathSync(dependencyPath)).toBe(realpathSync(previousTarget));
        expect(runNode([path.join(stagedDir, "serve.mjs"), "--once-list-tools"]).status).toBe(0);
        expect(readFileSync(path.join(previousTarget, "operator-file"), "utf8")).toBe("preserve");
      } else {
        expect(() => lstatSync(dependencyPath)).toThrow();
      }
      expect(
        readdirSync(stagedDir).filter((name) => name.startsWith("node_modules.backup-")),
      ).toEqual([]);
    },
  );

  it.each(["global-root fallback", "active store entry"])(
    "keeps a pnpm global package link upgrade-retargetable via %s",
    (discoveryMode) => {
      const installerPackage = makeInstallerPackage({ withDependencies: false });
      const runtime = makePnpmGlobalRuntime();
      const packageManagerBin = makeNpmRootShim(runtime.globalRoot);
      const home = makeTempDir("openclaw-bridge-home-");
      const openclawHome = path.join(home, ".openclaw");
      const dependencyPath = path.join(openclawHome, "claude-code-bridge", "node_modules");
      const result = runNode(
        [
          installerPackage.installerPath,
          "--home",
          home,
          "--openclaw-home",
          openclawHome,
          "--node",
          process.execPath,
          "--no-claude-settings",
          "--no-launchd",
        ],
        {
          env: {
            OPENCLAW_BIN:
              discoveryMode === "active store entry"
                ? path.join(runtime.firstStoreRoot, "openclaw.mjs")
                : path.join(home, "missing-openclaw"),
            PATH: `${packageManagerBin}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      if (process.platform !== "win32") {
        expect(readlinkSync(dependencyPath)).not.toContain(`${path.sep}.pnpm${path.sep}`);
      }
      rmSync(runtime.stablePackageRoot, { force: true });
      linkDirectory(runtime.secondStoreRoot, runtime.stablePackageRoot);
      expect(realpathSync(dependencyPath)).toBe(
        realpathSync(path.join(runtime.secondStoreRoot, "node_modules")),
      );
    },
  );
});

describe("Claude Code session bootstrap", () => {
  it("derives identity and stale handles only from the local vault", () => {
    const home = makeTempDir("openclaw-bridge-home-");
    const vaultDir = path.join(home, ".aurelius-memory", "memory");
    mkdirSync(vaultDir, { recursive: true });
    writeFileSync(
      path.join(vaultDir, "user_email_handles.md"),
      [
        "# Identity",
        "",
        "Do not use wrong@example.net for this seat.",
        "Primary email: operator@example.com; stale Claude handle: old-operator@example.net.",
        "Secondary contact: alias@example.com.",
      ].join("\n"),
      "utf8",
    );

    const result = runNode(["extensions/claude-code-bridge/session-bootstrap.mjs"], {
      env: { HOME: home },
    });

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    const context = payload.hookSpecificOutput.additionalContext;
    expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(context).toContain("primary email operator@example.com");
    expect(context).toContain("old-operator@example.net");
    expect(context).not.toContain("alias@example.com");
    const emittedEmails = new Set(context.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) ?? []);
    expect(emittedEmails).toEqual(
      new Set(["operator@example.com", "wrong@example.net", "old-operator@example.net"]),
    );
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
