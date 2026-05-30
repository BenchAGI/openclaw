import type { ChannelDoctorConfigMutation } from "@benchagi/openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";
import { normalizeCompatibilityConfig as normalizeCompatibilityConfigImpl } from "./doctor.js";

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  return normalizeCompatibilityConfigImpl({ cfg });
}
