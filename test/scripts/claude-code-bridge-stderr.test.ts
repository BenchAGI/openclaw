import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const bridgePath = "extensions/claude-code-bridge/serve.mjs";
const source = ts.createSourceFile(
  bridgePath,
  readFileSync(new URL(`../../${bridgePath}`, import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);

function functionSource(name: string): string {
  const matches = source.statements.filter(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === name,
  );
  const match = matches[0];
  expect(matches).toHaveLength(1);
  if (!match) {
    throw new Error(`function ${name} not found in ${bridgePath}`);
  }
  return match.getText(source).replace(/^export /, "");
}

// The standalone module reads installed config and connects MCP at top level.
// Evaluate only its classification constants/functions, never the entrypoint.
const constantNames = new Set([
  "BENIGN_STDERR_PREFIXES",
  "HARD_FAILURE_PATTERN",
  "STDERR_SGR_PATTERN",
  "STDERR_SGR_REGEX",
]);
const constants = source.statements.filter(
  (node) =>
    ts.isVariableStatement(node) &&
    node.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) && constantNames.has(declaration.name.text),
    ),
);
const probeSource = [
  ...constants.map((node) => node.getText(source)),
  functionSource("isWarningOnlyStderr"),
  functionSource("callGatewayMethod"),
  "({ isWarningOnlyStderr, callGatewayMethod })",
].join("\n");

type CommandResult = { exitCode: number; stdout: string; stderr: string };
type GatewayResult = {
  ok: boolean;
  data?: unknown;
  error?: string;
  exitCode: number;
  stderr: string;
  degraded?: boolean;
};

function createProbe(result: CommandResult = { exitCode: 0, stdout: "", stderr: "" }) {
  const runCommand = vi.fn(async () => result);
  const env = { OPENCLAW_GATEWAY_URL: "https://unused.invalid", SYNTHETIC_MARKER: "retained" };
  const probe = runInNewContext(
    probeSource,
    { runCommand, process: { env }, DEFAULT_OPENCLAW_BIN: "synthetic-openclaw" },
    { timeout: 1_000 },
  ) as {
    isWarningOnlyStderr: (stderr: unknown) => boolean;
    callGatewayMethod(
      method: string,
      params?: unknown,
      opts?: { timeoutMs?: number; expectFinal?: boolean },
    ): Promise<GatewayResult>;
  };
  return { ...probe, runCommand, env };
}

describe("standalone bridge stderr classification", () => {
  it.each([
    "[state-migrations] advisory",
    "Legacy state migration warnings:",
    "- Left existing state",
    "- Skipped existing state",
    "- Migrated existing state",
    " \r\n[state-migrations] advisory\r\n  - Left existing state\r\n ",
  ])("accepts known benign output: %j", (stderr) => {
    expect(createProbe().isWarningOnlyStderr(stderr)).toBe(true);
  });

  it.each(["\x1b[33m", "\x1b[m", "\x1b[;m", "\x1b[0;33m", "[33m", "[m", "[;;m"])(
    "strips exactly supported SGR decoration: %j",
    (sgr) => {
      const { isWarningOnlyStderr } = createProbe();
      const decorated = `${sgr}[state-migrations] advisory${sgr}\n${sgr}- Left state${sgr}`;
      expect(isWarningOnlyStderr(decorated)).toBe(true);
      expect(isWarningOnlyStderr(`${sgr}- Left er${sgr}ror`)).toBe(false);
      expect(isWarningOnlyStderr(decorated)).toBe(true);
    },
  );

  it.each([
    "error",
    "fatal",
    "panic",
    "unhandled",
    "traceback",
    "exception",
    "refused",
    "denied",
    "not found",
    "cannot",
    "failed",
  ])("refuses hard failures inside an allowed prefix: %s", (word) => {
    expect(createProbe().isWarningOnlyStderr(`- Left state: ${word.toUpperCase()}`)).toBe(false);
  });

  it.each([
    "",
    " \r\n ",
    undefined,
    null,
    42,
    {},
    "unknown advisory",
    "[state-migrations] advisory\nunknown advisory",
  ])("refuses empty or unrecognized output: %j", (stderr) => {
    expect(createProbe().isWarningOnlyStderr(stderr)).toBe(false);
  });

  it("preserves input string coercion and whole-word failure matching", () => {
    const { isWarningOnlyStderr } = createProbe();
    expect(isWarningOnlyStderr({ toString: () => "- Left state" })).toBe(true);
    expect(isWarningOnlyStderr("- Left errorless state")).toBe(true);
  });

  it.each(["\x1b]0;title\x07", "\x1b[2K", "\x9b33m", "\x1b[38:2m", "\x1b[33", "\x1b", "\x00"])(
    "does not strip unsupported leading controls: %j",
    (control) => {
      expect(createProbe().isWarningOnlyStderr(`${control}[state-migrations] advisory`)).toBe(
        false,
      );
    },
  );
});

describe("standalone bridge CLI result boundary", () => {
  it.each([
    [' {"answer":42} ', { answer: 42 }],
    [" usable text ", "usable text"],
  ])("retains degraded output for warning-only nonzero exits: %j", async (stdout, data) => {
    const result = { exitCode: 1, stdout, stderr: "\x1b[33m- Left state\x1b[0m" };
    const probe = createProbe(result);
    await expect(
      probe.callGatewayMethod(
        "status",
        { synthetic: true },
        {
          timeoutMs: 8_000,
          expectFinal: true,
        },
      ),
    ).resolves.toEqual({ ok: true, data, exitCode: 0, stderr: result.stderr, degraded: true });
    expect(probe.runCommand).toHaveBeenCalledWith(
      "synthetic-openclaw",
      [
        "gateway",
        "call",
        "status",
        "--json",
        "--timeout",
        "6000",
        "--expect-final",
        "--params",
        '{"synthetic":true}',
      ],
      { timeoutMs: 8_000, env: { SYNTHETIC_MARKER: "retained" } },
    );
    expect(probe.env.OPENCLAW_GATEWAY_URL).toBe("https://unused.invalid");
  });

  it.each([
    { exitCode: 1, stdout: " \n", stderr: "- Left state" },
    { exitCode: 1, stdout: '{"answer":42}', stderr: "- Left state: ERROR" },
    { exitCode: 124, stdout: "usable text", stderr: "[timeout after 15000ms]" },
    { exitCode: 1, stdout: "usable text", stderr: "" },
  ])("does not recover empty output or real faults: %j", async (result) => {
    await expect(createProbe(result).callGatewayMethod("status")).resolves.toEqual({
      ok: false,
      error: result.stderr || `openclaw exited with code ${result.exitCode}`,
      exitCode: result.exitCode,
      stderr: result.stderr,
    });
  });

  it.each([
    { stdout: "", data: null },
    { stdout: '{"answer":42}', data: { answer: 42 } },
  ])("preserves successful exits independently of stderr: %j", async ({ stdout, data }) => {
    const result = { exitCode: 0, stdout, stderr: "unclassified stderr" };
    const response = await createProbe(result).callGatewayMethod("status");
    expect(response).toEqual({
      ok: true,
      data,
      exitCode: 0,
      stderr: result.stderr,
      ...(stdout ? { degraded: false } : {}),
    });
  });
});
