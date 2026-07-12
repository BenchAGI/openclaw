// Memory Tap gateway registration stays plugin-owned so it is unavailable when memory-core is absent.
import { resolveDefaultAgentId } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import {
  MemoryTapInvalidRequestError,
  normalizeMemoryTapSnapshotParams,
} from "./memory-tap-contract.js";

const MEMORY_TAP_READ_SCOPE = { scope: "operator.read" as const };

export function registerMemoryTapGatewayMethod(api: OpenClawPluginApi): void {
  api.registerGatewayMethod(
    "memory.tap.snapshot",
    async ({ context, params, respond }) => {
      try {
        const runtime = await import("./memory-tap-snapshot.js");
        const cfg = context.getRuntimeConfig();
        const agentId = resolveDefaultAgentId(cfg);
        const request = normalizeMemoryTapSnapshotParams(params);
        const searchHealth = runtime.inspectMemoryTapSearchHealth({ cfg, agentId });
        respond(
          true,
          await runtime.buildMemoryTapSnapshot({
            cfg,
            agentId,
            workspaceDir: api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId),
            request,
            searchHealth,
          }),
        );
      } catch (error) {
        if (error instanceof MemoryTapInvalidRequestError) {
          respond(false, undefined, { code: error.code, message: error.message });
          return;
        }
        respond(false, undefined, {
          code: "internal_error",
          message: "memory tap snapshot failed",
        });
      }
    },
    MEMORY_TAP_READ_SCOPE,
  );
}
