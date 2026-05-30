import { buildChannelConfigSchema } from "@benchagi/openclaw/plugin-sdk/channel-config-schema";
import { z } from "@benchagi/openclaw/plugin-sdk/zod";

export const SynologyChatChannelConfigSchema = buildChannelConfigSchema(
  z
    .object({
      dangerouslyAllowNameMatching: z.boolean().optional(),
      dangerouslyAllowInheritedWebhookPath: z.boolean().optional(),
    })
    .passthrough(),
);
