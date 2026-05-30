import { listSkillCommandsForAgents as listSkillCommandsForAgentsImpl } from "@benchagi/openclaw/plugin-sdk/command-auth";

type ListSkillCommandsForAgents =
  typeof import("@benchagi/openclaw/plugin-sdk/command-auth").listSkillCommandsForAgents;

export function listSkillCommandsForAgents(
  ...args: Parameters<ListSkillCommandsForAgents>
): ReturnType<ListSkillCommandsForAgents> {
  return listSkillCommandsForAgentsImpl(...args);
}
