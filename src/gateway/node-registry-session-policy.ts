import type { NodeSkillDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveNodeCommandAllowlist,
  retainFulfilledNodeCapabilities,
} from "./node-command-policy.js";
import { resolveEffectiveComputerUseDescriptor } from "./node-computer-use-descriptor.js";
import type { NodeSession } from "./node-session.types.js";

export type NodeSessionPolicy = {
  approvedCaps: string[];
  approvedCommands: string[];
  skills: NodeSkillDescriptor[];
  withheldCommands: readonly string[];
};

type NodeSessionAuthority = Pick<NodeSession, "commands" | "caps" | "computerUse"> & {
  withheldCommands: readonly string[];
};

export function prepareNodeSessionAuthority(
  node: NodeSession,
  policy: NodeSessionPolicy,
  cfg: OpenClawConfig | undefined,
): NodeSessionAuthority {
  const declaredCommands = node.sessionCommandsCeiling ?? node.declaredCommands;
  // Withholding describes Gateway policy, not missing pairing approval.
  // Actual admission below still intersects the independently approved surface.
  const allowlist = cfg
    ? resolveNodeCommandAllowlist(cfg, {
        ...node,
        caps: node.sessionCapsCeiling ?? node.declaredCaps,
        commands: declaredCommands,
        approvedCommands: declaredCommands,
      })
    : undefined;
  const commands = policy.approvedCommands.filter(
    (command) => declaredCommands.includes(command) && (!allowlist || allowlist.has(command)),
  );
  // Capability visibility follows every admission gate, not policy diagnostics alone.
  const caps = retainFulfilledNodeCapabilities({
    caps: policy.approvedCaps,
    admittedCommands: commands,
    withheldCommands: declaredCommands.filter((command) => !commands.includes(command)),
  });
  return {
    commands,
    caps,
    computerUse: resolveEffectiveComputerUseDescriptor({
      commands,
      declared: node.declaredComputerUse,
    }),
    withheldCommands: allowlist
      ? declaredCommands.filter((command) => !allowlist.has(command))
      : policy.withheldCommands,
  };
}

export function installNodeSessionAuthority(
  node: NodeSession,
  policy: NodeSessionPolicy,
  authority: NodeSessionAuthority,
): void {
  const { withheldCommands, ...surface } = authority;
  policy.withheldCommands = withheldCommands;
  Object.assign(node, surface);
  Object.assign(node.client.connect, surface);
}
