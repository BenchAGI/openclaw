/* oxlint-disable unicorn/no-array-fill-with-reference-type -- CanvasRenderingContext2D.fill is not Array.fill. */
// Canvas-only rendering for Aurelius, Bench's canonical 120x120 animatronic eagle.
import { drawMascotEffect } from "./mascot-effects.ts";
import type { MascotPalette, MascotPose } from "./mascot-pose.ts";

const ART_SIZE = 120;
const TAU = Math.PI * 2;
const INK = "#080b12";
const FACE_PLATE = "#111827";
const FACE_PLATE_LIGHT = "#223047";
const EYE_GLOW = "#45adff";
const CIRCUIT_GLOW = "#218cff";
const BEAK_TOP = "#ffd34d";
const BEAK_BOTTOM = "#dc7d14";
const BEAK_SHADOW = "#8a3f0c";
const COPPER = "#b85c14";
const GOLD = "#f4a62a";
const GOLD_LIGHT = "#ffe16a";
const INFRARED = "#ff2d55";
const WORK_PLATE = "#252f3e";
const WORK_PLATE_LIGHT = "#536176";

type Point = { x: number; y: number };
type Bounds = { minX: number; minY: number; maxX: number; maxY: number };
type Shape = { path: Path2D; bounds: Bounds };
type MascotPaths = {
  body: Shape;
  leftWing: Shape;
  rightWing: Shape;
  facePlate: Path2D;
  chestPlate: Path2D;
  leftCircuit: Path2D;
  rightCircuit: Path2D;
};

let cachedPaths: MascotPaths | null = null;

function mascotPaths(): MascotPaths {
  if (cachedPaths) {
    return cachedPaths;
  }

  // A compact, front-facing eagle bust. The stepped feather tips carry the
  // pixel-art silhouette while curves keep the mark legible below 80px.
  const body = new Path2D();
  body.moveTo(60, 7);
  body.bezierCurveTo(47, 8, 37, 15, 31, 27);
  body.lineTo(25, 39);
  body.bezierCurveTo(27, 50, 30, 58, 35, 65);
  body.lineTo(26, 74);
  body.lineTo(35, 79);
  body.lineTo(27, 89);
  body.lineTo(41, 89);
  body.lineTo(37, 102);
  body.lineTo(51, 96);
  body.lineTo(60, 113);
  body.lineTo(69, 96);
  body.lineTo(83, 102);
  body.lineTo(79, 89);
  body.lineTo(93, 89);
  body.lineTo(85, 79);
  body.lineTo(94, 74);
  body.lineTo(85, 65);
  body.bezierCurveTo(90, 58, 93, 50, 95, 39);
  body.lineTo(89, 27);
  body.bezierCurveTo(83, 15, 73, 8, 60, 7);
  body.closePath();

  const leftWing = new Path2D();
  leftWing.moveTo(39, 54);
  leftWing.bezierCurveTo(29, 55, 18, 58, 8, 64);
  leftWing.lineTo(21, 69);
  leftWing.lineTo(4, 78);
  leftWing.lineTo(23, 81);
  leftWing.lineTo(9, 93);
  leftWing.lineTo(29, 90);
  leftWing.lineTo(22, 105);
  leftWing.lineTo(45, 95);
  leftWing.lineTo(49, 70);
  leftWing.closePath();

  const rightWing = new Path2D();
  rightWing.moveTo(81, 54);
  rightWing.bezierCurveTo(91, 55, 102, 58, 112, 64);
  rightWing.lineTo(99, 69);
  rightWing.lineTo(116, 78);
  rightWing.lineTo(97, 81);
  rightWing.lineTo(111, 93);
  rightWing.lineTo(91, 90);
  rightWing.lineTo(98, 105);
  rightWing.lineTo(75, 95);
  rightWing.lineTo(71, 70);
  rightWing.closePath();

  const facePlate = new Path2D();
  facePlate.moveTo(34, 28);
  facePlate.lineTo(46, 21);
  facePlate.lineTo(60, 24);
  facePlate.lineTo(74, 21);
  facePlate.lineTo(86, 28);
  facePlate.lineTo(82, 49);
  facePlate.lineTo(70, 59);
  facePlate.lineTo(60, 63);
  facePlate.lineTo(50, 59);
  facePlate.lineTo(38, 49);
  facePlate.closePath();

  const chestPlate = new Path2D();
  chestPlate.moveTo(43, 69);
  chestPlate.lineTo(60, 63);
  chestPlate.lineTo(77, 69);
  chestPlate.lineTo(72, 91);
  chestPlate.lineTo(60, 102);
  chestPlate.lineTo(48, 91);
  chestPlate.closePath();

  const leftCircuit = new Path2D();
  leftCircuit.moveTo(36, 31);
  leftCircuit.lineTo(42, 31);
  leftCircuit.lineTo(42, 45);
  leftCircuit.lineTo(49, 52);
  leftCircuit.lineTo(49, 73);
  leftCircuit.lineTo(41, 81);

  const rightCircuit = new Path2D();
  rightCircuit.moveTo(84, 31);
  rightCircuit.lineTo(78, 31);
  rightCircuit.lineTo(78, 45);
  rightCircuit.lineTo(71, 52);
  rightCircuit.lineTo(71, 73);
  rightCircuit.lineTo(79, 81);

  cachedPaths = {
    body: { path: body, bounds: { minX: 25, minY: 7, maxX: 95, maxY: 113 } },
    leftWing: { path: leftWing, bounds: { minX: 4, minY: 54, maxX: 49, maxY: 105 } },
    rightWing: { path: rightWing, bounds: { minX: 71, minY: 54, maxX: 116, maxY: 105 } },
    facePlate,
    chestPlate,
    leftCircuit,
    rightCircuit,
  };
  return cachedPaths;
}

function gradient(ctx: CanvasRenderingContext2D, shape: Shape, palette: MascotPalette) {
  const { bounds } = shape;
  const fill = ctx.createLinearGradient(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY);
  fill.addColorStop(0, palette.gradientTop);
  fill.addColorStop(1, palette.gradientBottom);
  return fill;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function rotated(
  ctx: CanvasRenderingContext2D,
  degrees: number,
  pivot: Point,
  draw: () => void,
): void {
  ctx.save();
  ctx.translate(pivot.x, pivot.y);
  ctx.rotate(radians(degrees));
  ctx.translate(-pivot.x, -pivot.y);
  draw();
  ctx.restore();
}

function ellipsePath(center: Point, radiusX: number, radiusY: number): Path2D {
  const path = new Path2D();
  path.ellipse(center.x, center.y, radiusX, radiusY, 0, 0, TAU);
  return path;
}

function drawEye(ctx: CanvasRenderingContext2D, center: Point, openness: number, pose: MascotPose) {
  const shifted = {
    x: center.x + pose.gaze.x * 2,
    y: center.y + pose.gaze.y * 1.5,
  };

  if (pose.happyEyes < 1) {
    const height = Math.max(1.2, 10 * openness * (1 - 0.6 * pose.happyEyes));
    ctx.save();
    ctx.globalAlpha *= 1 - pose.happyEyes;
    ctx.fillStyle = INK;
    ctx.fill(ellipsePath({ x: shifted.x, y: shifted.y + (10 - height) * 0.45 }, 6.5, height / 2));
    ctx.restore();
  }

  if (pose.happyEyes > 0) {
    const arc = new Path2D();
    arc.moveTo(shifted.x - 6, shifted.y + 2);
    arc.quadraticCurveTo(shifted.x, shifted.y - 5.5, shifted.x + 6, shifted.y + 2);
    ctx.save();
    ctx.globalAlpha *= pose.happyEyes;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.6;
    ctx.lineCap = "round";
    ctx.stroke(arc);
    ctx.restore();
  }

  if (pose.dizzy > 0) {
    const angle = pose.dizzyPhase * TAU + (center.x > 60 ? Math.PI : 0);
    const dot = {
      x: shifted.x + Math.cos(angle) * 3.4,
      y: shifted.y + Math.sin(angle) * 2.6,
    };
    ctx.save();
    ctx.globalAlpha *= pose.dizzy;
    ctx.fillStyle = EYE_GLOW;
    ctx.fill(ellipsePath(dot, 1.8, 1.8));
    ctx.restore();
  }

  const glowVisibility = pose.eyeGlowOpacity * openness * (1 - pose.happyEyes) * (1 - pose.dizzy);
  if (glowVisibility <= 0.01) {
    return;
  }
  const glowRadius = 2.1 * pose.glowScale;
  const glowCenter = {
    x: shifted.x + pose.gaze.x * 1.2,
    y: shifted.y - 0.4 + pose.gaze.y * 0.9,
  };
  ctx.save();
  ctx.globalAlpha *= glowVisibility;
  ctx.shadowColor = EYE_GLOW;
  ctx.shadowBlur = 5;
  ctx.fillStyle = EYE_GLOW;
  ctx.fill(ellipsePath(glowCenter, glowRadius, glowRadius));
  ctx.restore();
}

function drawBeak(ctx: CanvasRenderingContext2D, pose: MascotPose): void {
  const upper = new Path2D();
  upper.moveTo(49, 47);
  upper.quadraticCurveTo(60, 38, 71, 47);
  upper.lineTo(76, 51);
  upper.lineTo(66, 54);
  upper.quadraticCurveTo(63, 59, 60, 64);
  upper.quadraticCurveTo(57, 58, 44, 53);
  upper.closePath();
  const upperFill = ctx.createLinearGradient(48, 43, 70, 59);
  upperFill.addColorStop(0, GOLD_LIGHT);
  upperFill.addColorStop(0.55, BEAK_TOP);
  upperFill.addColorStop(1, BEAK_BOTTOM);
  ctx.fillStyle = upperFill;
  ctx.fill(upper);
  ctx.strokeStyle = BEAK_SHADOW;
  ctx.lineWidth = 0.8;
  ctx.stroke(upper);

  const opening = Math.max(
    pose.mouthOpen,
    pose.mouthRound * 0.85,
    Math.max(0, pose.mouthCurve) * 0.12,
  );
  if (opening > 0.04) {
    ctx.save();
    ctx.globalAlpha *= Math.min(1, opening * 2);
    ctx.fillStyle = INK;
    ctx.fill(ellipsePath({ x: 59.5, y: 57 + 2.5 * opening }, 6, 1.8 + 3.5 * opening));
    ctx.restore();
  }

  const lower = new Path2D();
  lower.moveTo(48, 55);
  lower.quadraticCurveTo(59, 60, 67, 55);
  lower.quadraticCurveTo(63, 64, 58, 66);
  lower.quadraticCurveTo(53, 62, 48, 55);
  lower.closePath();
  rotated(ctx, opening * 15 - pose.mouthCurve * 1.5, { x: 59, y: 55 }, () => {
    ctx.fillStyle = BEAK_BOTTOM;
    ctx.fill(lower);
    ctx.strokeStyle = BEAK_SHADOW;
    ctx.stroke(lower);
  });
}

function drawCheekLights(ctx: CanvasRenderingContext2D, pose: MascotPose): void {
  if (pose.blush <= 0.02) {
    return;
  }
  ctx.save();
  ctx.globalAlpha *= pose.blush * 0.75;
  ctx.fillStyle = INFRARED;
  ctx.shadowColor = INFRARED;
  ctx.shadowBlur = 4;
  ctx.fillRect(36, 52, 5, 2);
  ctx.fillRect(79, 52, 5, 2);
  ctx.restore();
}

function drawWorkCrest(ctx: CanvasRenderingContext2D, amount: number): void {
  if (amount <= 0.01) {
    return;
  }
  const plate = new Path2D();
  plate.moveTo(41, 21);
  plate.lineTo(47, 11);
  plate.lineTo(60, 7);
  plate.lineTo(73, 11);
  plate.lineTo(79, 21);
  plate.lineTo(72, 25);
  plate.lineTo(48, 25);
  plate.closePath();

  ctx.save();
  ctx.globalAlpha *= amount;
  ctx.translate(60, 20 - 14 * (1 - amount));
  ctx.rotate(radians(-4));
  ctx.translate(-60, -20);
  const fill = ctx.createLinearGradient(60, 7, 60, 25);
  fill.addColorStop(0, WORK_PLATE_LIGHT);
  fill.addColorStop(1, WORK_PLATE);
  ctx.fillStyle = fill;
  ctx.fill(plate);
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 1;
  ctx.stroke(plate);
  ctx.fillStyle = INFRARED;
  ctx.fillRect(53, 18, 14, 2.5);
  ctx.restore();
}

function drawBenchGlyph(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = INFRARED;
  ctx.fillRect(55, 73, 10, 2.2);
  ctx.fillRect(55, 78, 10, 2.2);
  ctx.fillRect(56.2, 75, 2.2, 10);
  ctx.fillRect(61.6, 75, 2.2, 10);
  ctx.restore();
}

function drawCircuitry(ctx: CanvasRenderingContext2D, paths: MascotPaths, pose: MascotPose): void {
  ctx.save();
  ctx.globalAlpha *= 0.42 + pose.eyeGlowOpacity * 0.45;
  ctx.strokeStyle = CIRCUIT_GLOW;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "square";
  ctx.stroke(paths.leftCircuit);
  ctx.stroke(paths.rightCircuit);
  ctx.fillStyle = EYE_GLOW;
  for (const point of [
    { x: 36, y: 31 },
    { x: 49, y: 52 },
    { x: 41, y: 81 },
    { x: 84, y: 31 },
    { x: 71, y: 52 },
    { x: 79, y: 81 },
  ]) {
    ctx.fillRect(point.x - 1.5, point.y - 1.5, 3, 3);
  }
  ctx.restore();
}

function drawPixelHighlights(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = GOLD_LIGHT;
  ctx.globalAlpha = 0.72;
  ctx.fillRect(43, 17, 5, 3);
  ctx.fillRect(32, 69, 5, 3);
  ctx.fillRect(75, 91, 4, 3);
  ctx.fillRect(69, 14, 4, 3);
  ctx.fillStyle = COPPER;
  ctx.fillRect(29, 84, 5, 3);
  ctx.fillRect(86, 69, 4, 3);
  ctx.fillRect(42, 94, 4, 3);
  ctx.restore();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Draw one Aurelius pose. Whole-body float is applied by the host to avoid canvas clipping. */
export function drawMascot(
  pose: MascotPose,
  palette: MascotPalette,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  const paths = mascotPaths();
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.scale(size / ART_SIZE, size / ART_SIZE);

  if (pose.bodyStretch !== 1) {
    const stretchX = clamp(1 + (1 - pose.bodyStretch) * 0.5, 0.97, 1.03);
    ctx.translate(60, 110);
    ctx.scale(stretchX, pose.bodyStretch);
    ctx.translate(-60, -110);
  }
  if (pose.bodyTilt !== 0) {
    ctx.translate(60, 60);
    ctx.rotate(radians(pose.bodyTilt));
    ctx.translate(-60, -60);
  }

  rotated(ctx, pose.leftClawDegrees, { x: 41, y: 62 }, () => {
    ctx.fillStyle = gradient(ctx, paths.leftWing, palette);
    ctx.fill(paths.leftWing.path);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.stroke(paths.leftWing.path);
  });
  rotated(ctx, pose.rightClawDegrees, { x: 79, y: 62 }, () => {
    ctx.fillStyle = gradient(ctx, paths.rightWing, palette);
    ctx.fill(paths.rightWing.path);
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.2;
    ctx.stroke(paths.rightWing.path);
  });

  ctx.fillStyle = gradient(ctx, paths.body, palette);
  ctx.fill(paths.body.path);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 1.4;
  ctx.stroke(paths.body.path);

  ctx.fillStyle = FACE_PLATE;
  ctx.fill(paths.facePlate);
  ctx.strokeStyle = FACE_PLATE_LIGHT;
  ctx.lineWidth = 1;
  ctx.stroke(paths.facePlate);

  ctx.fillStyle = "rgba(8, 11, 18, 0.58)";
  ctx.fill(paths.chestPlate);
  ctx.strokeStyle = COPPER;
  ctx.stroke(paths.chestPlate);

  drawPixelHighlights(ctx);
  drawCircuitry(ctx, paths, pose);

  const crestWiggle = pose.antennaDegrees * (1 - pose.antennaDroop);
  ctx.strokeStyle = palette.antenna;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "square";
  rotated(ctx, -pose.antennaDroop * 32 + crestWiggle, { x: 50, y: 18 }, () => {
    ctx.beginPath();
    ctx.moveTo(50, 18);
    ctx.lineTo(44, 10);
    ctx.lineTo(38, 9);
    ctx.stroke();
    ctx.fillStyle = EYE_GLOW;
    ctx.fillRect(36.5, 7.5, 3, 3);
  });
  rotated(ctx, pose.antennaDroop * 32 + crestWiggle, { x: 70, y: 18 }, () => {
    ctx.beginPath();
    ctx.moveTo(70, 18);
    ctx.lineTo(76, 10);
    ctx.lineTo(82, 9);
    ctx.stroke();
    ctx.fillStyle = EYE_GLOW;
    ctx.fillRect(80.5, 7.5, 3, 3);
  });

  drawWorkCrest(ctx, pose.hardHat);
  drawCheekLights(ctx, pose);
  drawEye(ctx, { x: 45, y: 38 }, pose.leftEyeOpenness, pose);
  drawEye(ctx, { x: 75, y: 38 }, pose.rightEyeOpenness, pose);
  drawBeak(ctx, pose);
  drawBenchGlyph(ctx);
  drawMascotEffect(ctx, pose, palette);
  ctx.restore();
}
