import type { Command } from "commander";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import type { OperatorScope } from "../../gateway/method-scopes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../gateway/protocol/client-info.js";
import { withProgress } from "../progress.js";

export type GatewayRpcOpts = {
  config?: OpenClawConfig;
  url?: string;
  token?: string;
  password?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
  scope?: string[];
};

export const gatewayCallOpts = (cmd: Command) =>
  cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--password <password>", "Gateway password (password auth)")
    .option("--timeout <ms>", "Timeout in ms", "10000")
    .option("--expect-final", "Wait for final response (agent)", false)
    .option(
      "--scope <scope...>",
      "Request only these operator scope(s) instead of the full CLI default set " +
        "(least-privilege; repeatable). Lets callers that only need e.g. operator.read " +
        "connect without triggering a scope-upgrade pairing request.",
    )
    .option("--json", "Output JSON", false);

function normalizeRequestedScopes(scope: string[] | undefined): OperatorScope[] | undefined {
  if (!Array.isArray(scope)) {
    return undefined;
  }
  const trimmed = scope.map((value) => value.trim()).filter((value) => value.length > 0);
  return trimmed.length > 0 ? (trimmed as OperatorScope[]) : undefined;
}

export const callGatewayCli = async (method: string, opts: GatewayRpcOpts, params?: unknown) =>
  withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: opts.json !== true,
    },
    async () =>
      await callGateway({
        config: opts.config,
        url: opts.url,
        token: opts.token,
        password: opts.password,
        method,
        params,
        expectFinal: Boolean(opts.expectFinal),
        timeoutMs: Number(opts.timeout ?? 10_000),
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        mode: GATEWAY_CLIENT_MODES.CLI,
        scopes: normalizeRequestedScopes(opts.scope),
      }),
  );
