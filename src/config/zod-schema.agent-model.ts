// Defines agent model selection schema fragments.
import { z } from "zod";

const AgentModelObjectShape = {
  primary: z.string().optional(),
  fallbacks: z.array(z.string()).optional(),
};

/** Schema for agent model config accepting a string or fallback object. */
export const AgentModelSchema = z.union([z.string(), z.object(AgentModelObjectShape).strict()]);

/** Schema for `agents.defaults.model`, which also carries chat visibility for the fallback notice. */
export const AgentDefaultsModelSchema = z.union([
  z.string(),
  z
    .object({
      ...AgentModelObjectShape,
      showFallbackNoticeInChat: z
        .boolean()
        .optional()
        .describe(
          "Render the model-fallback notice in chat on every surface, including external messaging channels (default: false — operator surfaces only).",
        ),
    })
    .strict(),
]);

export const AgentToolModelSchema = z.union([
  z.string(),
  z
    .object({
      primary: z.string().optional(),
      fallbacks: z.array(z.string()).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
