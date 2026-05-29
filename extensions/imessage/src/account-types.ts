import type { OpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";

export type IMessageAccountConfig = Omit<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["imessage"]>,
  "accounts" | "defaultAccount"
>;
