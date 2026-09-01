// Renders Aurelius, Bench's golden-eagle mascot, from the high-fidelity
// bitmap in public/app-art. The pose model still drives motion (float is
// applied by the host; stretch/tilt/glow/effects composite here), while the
// artwork itself comes from the asset so fidelity is not bounded by canvas
// path work.
import { inferControlUiPublicAssetPath } from "../app/public-assets.ts";
import { drawMascotEffect } from "./mascot-effects.ts";
import type { MascotPalette, MascotPose } from "./mascot-pose.ts";

const ART_SIZE = 120;
const ART_ASSET = "app-art/aurelius-mascot.png";
// The bird sits inside this box within the 120-unit frame, leaving air for
// glow and particle effects around the silhouette.
const ART_INSET = 8;

let artImage: HTMLImageElement | null = null;
let artReady = false;
const artReadyListeners = new Set<() => void>();

function ensureArtLoading(): void {
  if (artImage || typeof Image === "undefined") {
    return;
  }
  artImage = new Image();
  artImage.decoding = "async";
  artImage.addEventListener(
    "load",
    () => {
      artReady = true;
      for (const listener of artReadyListeners) {
        listener();
      }
      artReadyListeners.clear();
    },
    { once: true },
  );
  artImage.src = inferControlUiPublicAssetPath(ART_ASSET);
}

/**
 * Runs the listener once the mascot artwork is decodable. Hosts that draw a
 * single static frame (reduced motion, first paint) subscribe so the canvas
 * is not left empty when the bitmap arrives after their draw.
 */
export function whenMascotArtReady(listener: () => void): void {
  ensureArtLoading();
  if (artReady) {
    listener();
    return;
  }
  artReadyListeners.add(listener);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function drawGlow(ctx: CanvasRenderingContext2D, pose: MascotPose, palette: MascotPalette): void {
  const alpha = clamp(pose.eyeGlowOpacity, 0, 1) * 0.28;
  if (alpha <= 0.01) {
    return;
  }
  const radius = 52 * clamp(pose.glowScale, 0.6, 1.6);
  const glow = ctx.createRadialGradient(60, 62, radius * 0.25, 60, 62, radius);
  glow.addColorStop(0, palette.gradientTop);
  glow.addColorStop(1, "rgba(0, 0, 0, 0)");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, ART_SIZE, ART_SIZE);
  ctx.restore();
}

/** Draw one Aurelius pose. Whole-body float is applied by the host to avoid canvas clipping. */
export function drawMascot(
  pose: MascotPose,
  palette: MascotPalette,
  ctx: CanvasRenderingContext2D,
  size: number,
): void {
  ensureArtLoading();
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.scale(size / ART_SIZE, size / ART_SIZE);

  drawGlow(ctx, pose, palette);

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

  if (artReady && artImage) {
    // Sleepy/sad eye closure reads as the whole bird settling: ease the
    // artwork slightly darker instead of repainting facial features.
    const settle = 1 - Math.min(pose.leftEyeOpenness, pose.rightEyeOpenness);
    if (settle > 0.35) {
      ctx.filter = `brightness(${1 - (settle - 0.35) * 0.25})`;
    }
    ctx.drawImage(
      artImage,
      ART_INSET,
      ART_INSET,
      ART_SIZE - ART_INSET * 2,
      ART_SIZE - ART_INSET * 2,
    );
    ctx.filter = "none";
  }

  drawMascotEffect(ctx, pose, palette, (path) => ctx.fill(path));
  ctx.restore();
}
