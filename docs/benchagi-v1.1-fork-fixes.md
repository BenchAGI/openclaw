# BenchAGI V1.1 Fork Fixes

This checklist records the OpenClaw fork gaps investigated during the BenchAGI V1.1 integration pass.

## Findings

- [x] Tool event emitter: `src/agents/pi-embedded-subscribe.handlers.tools.ts` emits `stream: "tool"` result events and separate `stream: "command_output"` events for exec output.
- [x] Exec detail source: foreground exec details are built in `src/agents/bash-tools.exec.ts` from `src/agents/bash-tools.exec-runtime.ts`; the runtime has separate stderr buffers before it builds the terminal result.
- [x] `chat.send` handler: `src/gateway/server-methods/chat.ts` uses the caller-provided `idempotencyKey` as the run id and maintains a process-local dedupe cache.
- [x] Dedupe retention: `src/gateway/server-constants.ts` sets `DEDUPE_TTL_MS = 5 * 60_000`; gateway maintenance prunes stale dedupe entries on its existing interval.
- [x] `chat.history` handler: `src/gateway/server-methods/chat.ts` reads durable transcript messages from the session store.
- [x] Transport frame sequence: WebSocket broadcast sequence is process-local in `src/gateway/server-broadcast.ts`; transport/agent frames are not durably replayed by `chat.history` today.

## Decisions

- [x] Gap A: fixed. Failed exec-like tool result events now carry additive `exitCode`, bounded `stderr`, `error`, `errorMessage`, and `durationMs` fields when the underlying executor knows them.
- [x] Gap B: verified and hardened. `chat.send` dedupe is now explicitly keyed by `(canonicalSessionKey, idempotencyKey)` while preserving the existing run id response shape and `agent.wait` compatibility.
- [x] Gap C: documented with minimal compatibility. `chat.history` accepts `sinceSeq` and returns empty `events`/`frames` plus `eventHistory.persisted: false` to make the current limitation explicit.

## Follow-Up

- Durable transport-frame replay or a session-generation marker should be designed separately if clients need complete event recovery across gateway restarts.
