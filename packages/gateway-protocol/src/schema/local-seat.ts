// Local seat capture schemas bridge desktop CLI seats into gateway memory intake.
import type { Static } from "typebox";
import { Type } from "typebox";
import { NonEmptyString } from "./primitives.js";

const LocalSeatKindSchema = Type.Union([Type.Literal("claude-code"), Type.Literal("codex-cli")]);

const LocalSeatEventSchema = Type.Union([
  Type.Literal("session_start"),
  Type.Literal("user_prompt"),
  Type.Literal("assistant_response"),
  Type.Literal("tool_result"),
  Type.Literal("summary"),
  Type.Literal("session_stop"),
]);

const CaptureTextSchema = Type.String({ maxLength: 50_000 });
const CaptureSummarySchema = Type.String({ maxLength: 4_000 });
const CaptureContextStringSchema = Type.String({ maxLength: 1_000 });

export const LocalSeatCaptureParamsSchema = Type.Object(
  {
    agentId: NonEmptyString,
    seatKind: LocalSeatKindSchema,
    seatSessionId: NonEmptyString,
    event: LocalSeatEventSchema,
    summary: Type.Optional(CaptureSummarySchema),
    text: Type.Optional(CaptureTextSchema),
    cwd: Type.Optional(CaptureContextStringSchema),
    host: Type.Optional(CaptureContextStringSchema),
    platform: Type.Optional(CaptureContextStringSchema),
    launcherVersion: Type.Optional(CaptureContextStringSchema),
    providerVersion: Type.Optional(CaptureContextStringSchema),
    source: Type.Optional(CaptureContextStringSchema),
    ts: Type.Optional(CaptureContextStringSchema),
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

export type LocalSeatCaptureParams = Static<typeof LocalSeatCaptureParamsSchema>;
export type LocalSeatCaptureResult = Static<typeof LocalSeatCaptureResultSchema>;
