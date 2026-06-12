import { Type } from "@sinclair/typebox";
import { NonEmptyString } from "./primitives.js";

export const LocalSeatKindSchema = Type.Union([
  Type.Literal("claude-code"),
  Type.Literal("codex-cli"),
]);

export const LocalSeatCaptureEventSchema = Type.Union([
  Type.Literal("session_start"),
  Type.Literal("user_prompt"),
  Type.Literal("assistant_response"),
  Type.Literal("tool_result"),
  Type.Literal("summary"),
  Type.Literal("session_stop"),
]);

export const LocalSeatCaptureParamsSchema = Type.Object(
  {
    agentId: Type.String({ minLength: 1, maxLength: 128 }),
    seatKind: LocalSeatKindSchema,
    seatSessionId: Type.String({ minLength: 1, maxLength: 160 }),
    event: LocalSeatCaptureEventSchema,
    summary: Type.Optional(Type.String({ maxLength: 4_000 })),
    text: Type.Optional(Type.String({ maxLength: 12_000 })),
    cwd: Type.Optional(Type.String({ maxLength: 2_000 })),
    host: Type.Optional(Type.String({ maxLength: 255 })),
    platform: Type.Optional(Type.String({ maxLength: 120 })),
    launcherVersion: Type.Optional(Type.String({ maxLength: 120 })),
    providerVersion: Type.Optional(Type.String({ maxLength: 120 })),
    source: Type.Optional(Type.String({ maxLength: 120 })),
    ts: Type.Optional(Type.Integer({ minimum: 0 })),
    wake: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export const LocalSeatCaptureResultSchema = Type.Object(
  {
    ok: Type.Literal(true),
    capturePath: NonEmptyString,
    queued: Type.Boolean(),
  },
  { additionalProperties: false },
);
