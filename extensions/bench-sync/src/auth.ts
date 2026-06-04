// Resolve the Bench instance API key for the bench-sync plugin.
//
// The key is configured as a SecretRef at gateway.benchCloud.apiKeyRef and is
// resolved through the repo's runtime SecretRef resolver (env/file/exec
// sources). The plaintext key value is NEVER logged or placed in error
// messages — only the SecretRef label (source:provider:id) and resolution
// status are ever surfaced.

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveRequiredConfiguredSecretRefInputString } from "openclaw/plugin-sdk/secret-input-runtime";

export type ResolveApiKeyResult =
  | { status: "ok"; apiKey: string }
  | { status: "unset" }
  | { status: "error"; reason: string };

/**
 * Resolve the Bench cloud API key from gateway.benchCloud.apiKeyRef.
 *
 * SecretRef-only by design: gateway.benchCloud has no plaintext apiKey field,
 * so there is no legacy plaintext precedent to honor here. Returns:
 * - { status: "ok", apiKey } when the SecretRef resolved to a non-empty string
 * - { status: "unset" } when no apiKeyRef is configured
 * - { status: "error", reason } when a ref is configured but cannot be resolved
 *
 * `reason` carries only the resolver's redacted message (path + ref label),
 * never the secret value.
 */
export async function resolveApiKey(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<ResolveApiKeyResult> {
  const apiKeyRef = params.config.gateway?.benchCloud?.apiKeyRef;
  if (apiKeyRef === undefined || apiKeyRef === null) {
    return { status: "unset" };
  }

  try {
    const resolved = await resolveRequiredConfiguredSecretRefInputString({
      config: params.config,
      env: params.env ?? process.env,
      value: apiKeyRef,
      path: "gateway.benchCloud.apiKeyRef",
      unresolvedReasonStyle: "generic",
    });
    if (typeof resolved === "string" && resolved.length > 0) {
      return { status: "ok", apiKey: resolved };
    }
    // refConfigured but resolver returned undefined: treat as unset config.
    return { status: "unset" };
  } catch (err) {
    // The resolver's error message is built from path + ref label only and
    // does not include the secret value. Surface it as-is.
    return {
      status: "error",
      reason: err instanceof Error ? err.message : "gateway.benchCloud.apiKeyRef is unresolved",
    };
  }
}
