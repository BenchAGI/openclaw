// Default watchdog timing bounds for CLI-backed agent sessions.
export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 1_000;

export const CLI_FRESH_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 600_000,
} as const;

// Genuinely-interactive web-chat (gateway /v1/chat/completions + /v1/responses,
// console) FRESH turns: keep the 180s cold-start floor (process spawn + MCP/plugin
// bundle load + prompt assembly + provider connect to first stdout line), but cap
// the hang ceiling at 240s so a wedged console turn fails in ~4min instead of ~10.
// Deliberately NOT applied to cron (the dream pipeline keeps the 600s FRESH
// ceiling), web-chat continuations (RESUME, 180s), other channels (slack/sms/...),
// or foreground subagent runs (trigger "user" but no "webchat" channel). An explicit
// per-backend `watchdog.fresh` override opts out (the !configured guard).
export const CLI_INTERACTIVE_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.8,
  minMs: 180_000,
  maxMs: 240_000,
} as const;

export const CLI_RESUME_WATCHDOG_DEFAULTS = {
  noOutputTimeoutRatio: 0.3,
  minMs: 60_000,
  maxMs: 180_000,
} as const;
