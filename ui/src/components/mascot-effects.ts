import type { MascotPalette, MascotPose } from "./mascot-pose.ts";

const ART_SIZE = 120;
const EYE_GLOW = "#45adff";
const GOLD = "#f4a62a";

type Point = { x: number; y: number };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function easeInOut(value: number): number {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function bell(value: number): number {
  const t = clamp(value, 0, 1);
  return easeInOut(t < 0.5 ? t * 2 : (1 - t) * 2);
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function sparklePath(center: Point, size: number): Path2D {
  const path = new Path2D();
  path.moveTo(center.x, center.y - size);
  for (const [dx, dy] of [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
  ] as const) {
    path.quadraticCurveTo(center.x, center.y, center.x + size * dx, center.y + size * dy);
  }
  path.closePath();
  return path;
}

function drawZ(ctx: CanvasRenderingContext2D, position: Point, size: number, alpha: number): void {
  const path = new Path2D();
  const width = size * 0.62;
  const height = size * 0.78;
  path.moveTo(position.x - width / 2, position.y - height / 2);
  path.lineTo(position.x + width / 2, position.y - height / 2);
  path.lineTo(position.x - width / 2, position.y + height / 2);
  path.lineTo(position.x + width / 2, position.y + height / 2);
  ctx.save();
  ctx.globalAlpha *= alpha * 0.9;
  ctx.strokeStyle = EYE_GLOW;
  ctx.lineWidth = Math.max(1.2, size * 0.16);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.stroke(path);
  ctx.restore();
}

export function drawMascotEffect(
  ctx: CanvasRenderingContext2D,
  pose: MascotPose,
  palette: MascotPalette,
  fillPath: (path: Path2D) => void,
): void {
  switch (pose.effect) {
    case "none":
      return;
    case "sparkles":
      for (let index = 0; index < 6; index += 1) {
        const phase = (pose.effectPhase + index * 0.37) % 1;
        const alpha = bell(phase);
        if (alpha <= 0.05) {
          continue;
        }
        const angle = Math.PI + (Math.PI * (index + 0.5)) / 6;
        const center = {
          x: 60 + Math.cos(angle) * (50 + (index % 3) * 4),
          y: 55 + Math.sin(angle) * (40 + ((index * 5) % 3) * 4),
        };
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.fillStyle = index % 2 === 0 ? EYE_GLOW : palette.antenna;
        fillPath(sparklePath(center, 2.5 + 2 * alpha));
        ctx.restore();
      }
      return;
    case "zzz":
      for (let index = 0; index < 3; index += 1) {
        const phase = (pose.effectPhase + index * 0.33) % 1;
        const alpha = phase < 0.2 ? phase / 0.2 : 1 - (phase - 0.2) / 0.8;
        if (alpha <= 0.05) {
          continue;
        }
        drawZ(
          ctx,
          { x: 86 + 14 * phase + 2 * Math.sin(phase * 4 * Math.PI), y: 24 - 20 * phase },
          6 + 4 * phase,
          alpha,
        );
      }
      return;
    case "sparks":
      for (let index = 0; index < 5; index += 1) {
        const rawPhase = pose.effectPhase - index * 0.025;
        if (rawPhase < 0 || rawPhase >= 0.45) {
          continue;
        }
        const alpha = rawPhase < 0.08 ? rawPhase / 0.08 : 1 - (rawPhase - 0.08) / 0.37;
        const angle = radians(-160 + index * 35);
        const radius = 5 + (12 * rawPhase) / 0.45;
        const particleSize = 2.2 + (index % 3) * 0.8;
        const center = {
          x: clamp(106 + Math.cos(angle) * radius, particleSize, ART_SIZE - particleSize),
          y: clamp(66 + Math.sin(angle) * radius, particleSize, ART_SIZE - particleSize),
        };
        ctx.save();
        ctx.globalAlpha *= alpha;
        ctx.fillStyle = index % 2 === 0 ? EYE_GLOW : GOLD;
        fillPath(sparklePath(center, particleSize));
        ctx.restore();
      }
      return;
    case "sweat": {
      const alpha = bell(pose.effectPhase);
      if (alpha <= 0.02) {
        return;
      }
      const center = { x: 42, y: 24 + 7 * pose.effectPhase };
      const drop = new Path2D();
      drop.moveTo(center.x, center.y - 3);
      drop.bezierCurveTo(
        center.x - 4,
        center.y + 1,
        center.x - 2,
        center.y + 3,
        center.x,
        center.y + 3,
      );
      drop.bezierCurveTo(
        center.x + 2,
        center.y + 3,
        center.x + 4,
        center.y + 1,
        center.x,
        center.y - 3,
      );
      ctx.save();
      ctx.globalAlpha *= alpha;
      ctx.fillStyle = "#80d4ff";
      fillPath(drop);
      ctx.restore();
    }
  }
}
