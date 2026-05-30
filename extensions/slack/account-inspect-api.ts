import type { OpenClawConfig } from "@benchagi/openclaw/plugin-sdk/config-runtime";
import { inspectSlackAccount } from "./src/account-inspect.js";

export function inspectSlackReadOnlyAccount(cfg: OpenClawConfig, accountId?: string | null) {
  return inspectSlackAccount({ cfg, accountId });
}
