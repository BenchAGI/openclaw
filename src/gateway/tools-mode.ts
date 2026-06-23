import type { IncomingMessage } from "node:http";
import { SAFE_READ_ONLY_TOOLS } from "../agents/tool-policy-shared.js";

const GATEWAY_TOOLS_MODE_HEADER = "x-openclaw-tools-mode";

/** Resolve the Gateway agency-mode header into a runtime tool allowlist. */
export function resolveGatewayToolsModeAllowlist(
  req: Pick<IncomingMessage, "headers">,
): string[] | undefined {
  const rawHeader = req.headers[GATEWAY_TOOLS_MODE_HEADER];
  const toolsMode = (Array.isArray(rawHeader) ? rawHeader[0] : rawHeader)?.trim().toLowerCase();
  return toolsMode === "plan" || toolsMode === "review" ? [...SAFE_READ_ONLY_TOOLS] : undefined;
}
