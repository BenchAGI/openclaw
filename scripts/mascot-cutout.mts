#!/usr/bin/env node
// One-off asset tool: removes the near-flat background from the generated
// Aurelius eagle artwork via flood fill from the image edges (so light
// interior feathers are never punched out), feathers the cut edge, trims the
// transparent margin, and writes the sized mascot PNG into ui/public/app-art.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";

const source = process.argv[2];
const destination = process.argv[3] ?? "ui/public/app-art/aurelius-mascot.png";
const targetSize = Number(process.argv[4] ?? 640);
if (!source) {
  throw new Error("usage: mascot-cutout.mts <source-image> [destination] [size]");
}

const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
if (!(await canRunPlaywrightChromium(executablePath))) {
  throw new Error(`Playwright Chromium is unavailable at ${executablePath}`);
}

const sourceBytes = await readFile(path.resolve(source));
const browser = await chromium.launch({ executablePath });
const page = await browser.newPage();
try {
  // tsx/esbuild injects __name helper calls into evaluated functions; the
  // browser context needs the no-op for the closure to run.
  await page.addInitScript("globalThis.__name = (fn) => fn;");
  await page.goto("about:blank");
  const dataUrl = `data:image/jpeg;base64,${sourceBytes.toString("base64")}`;
  const result = await page.evaluate(
    async ({ dataUrl, targetSize }) => {
      const image = new Image();
      image.src = dataUrl;
      await image.decode();
      const w = image.naturalWidth;
      const h = image.naturalHeight;
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(image, 0, 0);
      const frame = ctx.getImageData(0, 0, w, h);
      const px = frame.data;

      // Background reference: average the four corner pixels.
      const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + w - 1) * 4];
      let br = 0;
      let bg = 0;
      let bb = 0;
      for (const offset of corners) {
        br += px[offset];
        bg += px[offset + 1];
        bb += px[offset + 2];
      }
      br /= 4;
      bg /= 4;
      bb /= 4;

      const distance = (offset: number) => {
        const dr = px[offset] - br;
        const dg = px[offset + 1] - bg;
        const db = px[offset + 2] - bb;
        return Math.sqrt(dr * dr + dg * dg + db * db);
      };

      // BFS flood fill from every edge pixel; JPEG noise needs tolerance but
      // light plumage must not leak, so the walkable set is background-like
      // pixels whose 5x5 neighborhood is also background-like — the fill then
      // cannot squeeze through channels narrower than the guard window.
      const HARD = 26; // definitely background
      const SOFT = 60; // partial alpha ramp near the silhouette
      const GUARD = 2; // half-width of the neighborhood the fill must fit through
      const backgroundLike = new Uint8Array(w * h);
      for (let index = 0; index < w * h; index += 1) {
        if (distance(index * 4) <= HARD) {
          backgroundLike[index] = 1;
        }
      }
      const walkable = (x: number, y: number): boolean => {
        for (let dy = -GUARD; dy <= GUARD; dy += 1) {
          for (let dx = -GUARD; dx <= GUARD; dx += 1) {
            const nx = Math.min(w - 1, Math.max(0, x + dx));
            const ny = Math.min(h - 1, Math.max(0, y + dy));
            if (!backgroundLike[ny * w + nx]) {
              return false;
            }
          }
        }
        return true;
      };
      const state = new Uint8Array(w * h); // 0 unknown, 1 background, 2 queued
      const queue: number[] = [];
      const push = (x: number, y: number) => {
        const index = y * w + x;
        if (state[index]) return;
        if (backgroundLike[index] && walkable(x, y)) {
          state[index] = 2;
          queue.push(index);
        }
      };
      for (let x = 0; x < w; x += 1) {
        push(x, 0);
        push(x, h - 1);
      }
      for (let y = 0; y < h; y += 1) {
        push(0, y);
        push(w - 1, y);
      }
      while (queue.length) {
        const index = queue.pop() as number;
        state[index] = 1;
        const x = index % w;
        const y = (index - x) / w;
        if (x > 0) push(x - 1, y);
        if (x < w - 1) push(x + 1, y);
        if (y > 0) push(x, y - 1);
        if (y < h - 1) push(x, y + 1);
      }
      // Grow the filled region back over the guard margin: background-like
      // pixels adjacent to filled background join it, repeated to cover the
      // guard radius plus antialiasing slop.
      for (let round = 0; round < GUARD + 2; round += 1) {
        for (let index = 0; index < w * h; index += 1) {
          if (state[index] === 1 || !backgroundLike[index]) {
            continue;
          }
          const x = index % w;
          const y = (index - x) / w;
          if (
            (x > 0 && state[index - 1] === 1) ||
            (x < w - 1 && state[index + 1] === 1) ||
            (y > 0 && state[index - w] === 1) ||
            (y < h - 1 && state[index + w] === 1)
          ) {
            state[index] = 3;
          }
        }
        for (let index = 0; index < w * h; index += 1) {
          if (state[index] === 3) {
            state[index] = 1;
          }
        }
      }

      // Enclosed background pockets (for example between the legs) can never
      // be reached from the border. Clear any remaining background-like
      // connected component whose area is large enough to be a pocket rather
      // than a highlight such as an eye glint.
      const POCKET_MIN_AREA = 300;
      const componentSeen = new Uint8Array(w * h);
      for (let start = 0; start < w * h; start += 1) {
        if (state[start] === 1 || !backgroundLike[start] || componentSeen[start]) {
          continue;
        }
        const component: number[] = [start];
        componentSeen[start] = 1;
        for (let cursor = 0; cursor < component.length; cursor += 1) {
          const index = component[cursor];
          const x = index % w;
          const y = (index - x) / w;
          for (const neighbor of [
            x > 0 ? index - 1 : -1,
            x < w - 1 ? index + 1 : -1,
            y > 0 ? index - w : -1,
            y < h - 1 ? index + w : -1,
          ]) {
            if (
              neighbor >= 0 &&
              !componentSeen[neighbor] &&
              state[neighbor] !== 1 &&
              backgroundLike[neighbor]
            ) {
              componentSeen[neighbor] = 1;
              component.push(neighbor);
            }
          }
        }
        if (component.length >= POCKET_MIN_AREA) {
          for (const index of component) {
            state[index] = 1;
          }
        }
      }

      // Distance-to-background rings: ring 1 touches transparency, ring 2
      // touches ring 1. Both get color decontamination; ring 1 also sheds
      // most of its alpha so no light contour survives on dark surfaces.
      const ring = new Uint8Array(w * h);
      for (let index = 0; index < w * h; index += 1) {
        if (state[index] === 1) {
          continue;
        }
        const x = index % w;
        const y = (index - x) / w;
        if (
          (x > 0 && state[index - 1] === 1) ||
          (x < w - 1 && state[index + 1] === 1) ||
          (y > 0 && state[index - w] === 1) ||
          (y < h - 1 && state[index + w] === 1)
        ) {
          ring[index] = 1;
        }
      }
      for (let index = 0; index < w * h; index += 1) {
        if (state[index] === 1 || ring[index]) {
          continue;
        }
        const x = index % w;
        const y = (index - x) / w;
        if (
          (x > 0 && ring[index - 1] === 1) ||
          (x < w - 1 && ring[index + 1] === 1) ||
          (y > 0 && ring[index - w] === 1) ||
          (y < h - 1 && ring[index + w] === 1)
        ) {
          ring[index] = 2;
        }
      }

      // Apply alpha with un-mixing: c = fg*a + bg*(1-a) => fg = (c - bg*(1-a)) / a
      const decontaminate = (offset: number, alpha: number) => {
        px[offset + 3] = Math.round(255 * alpha);
        for (let channel = 0; channel < 3; channel += 1) {
          const backgroundChannel = channel === 0 ? br : channel === 1 ? bg : bb;
          const value =
            (px[offset + channel] - backgroundChannel * (1 - alpha)) / Math.max(alpha, 0.05);
          px[offset + channel] = Math.min(255, Math.max(0, Math.round(value)));
        }
      };
      for (let index = 0; index < w * h; index += 1) {
        const offset = index * 4;
        if (state[index] === 1) {
          px[offset + 3] = 0;
          continue;
        }
        const d = distance(offset);
        if (ring[index] === 1) {
          const alpha = Math.min(0.7, Math.max(0.15, (d - HARD * 0.5) / (SOFT - HARD * 0.5)) * 0.7);
          decontaminate(offset, alpha);
        } else if (ring[index] === 2 && d < SOFT * 2) {
          const alpha = Math.min(1, Math.max(0.6, d / (SOFT * 2)));
          decontaminate(offset, alpha);
        }
      }

      // Smooth the alpha channel (two 3x3 mean passes). Uniform regions are
      // unchanged; the ragged, stippled cut edge becomes an anti-aliased rim.
      for (let pass = 0; pass < 2; pass += 1) {
        const smoothed = new Uint8ClampedArray(w * h);
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            let total = 0;
            let count = 0;
            for (let dy = -1; dy <= 1; dy += 1) {
              for (let dx = -1; dx <= 1; dx += 1) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                  total += px[(ny * w + nx) * 4 + 3];
                  count += 1;
                }
              }
            }
            smoothed[y * w + x] = Math.round(total / count);
          }
        }
        for (let index = 0; index < w * h; index += 1) {
          px[index * 4 + 3] = smoothed[index];
        }
      }

      // The blur lends alpha to former background pixels whose colors are
      // still near-white; un-mix every partial pixel so residue trends dark
      // and disappears on dark surfaces instead of ringing light.
      for (let index = 0; index < w * h; index += 1) {
        const offset = index * 4;
        const alpha = px[offset + 3];
        if (alpha > 0 && alpha < 250) {
          decontaminate(offset, alpha / 255);
        }
      }
      ctx.putImageData(frame, 0, 0);

      // Trim the transparent margin, keep a small uniform pad, then resize.
      let minX = w;
      let minY = h;
      let maxX = 0;
      let maxY = 0;
      for (let y = 0; y < h; y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (px[(y * w + x) * 4 + 3] > 8) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const pad = Math.round((maxX - minX) * 0.03);
      minX = Math.max(0, minX - pad);
      minY = Math.max(0, minY - pad);
      maxX = Math.min(w - 1, maxX + pad);
      maxY = Math.min(h - 1, maxY + pad);
      const cropWidth = maxX - minX + 1;
      const cropHeight = maxY - minY + 1;
      const square = Math.max(cropWidth, cropHeight);

      const out = document.createElement("canvas");
      out.width = targetSize;
      out.height = targetSize;
      const outCtx = out.getContext("2d");
      if (!outCtx) throw new Error("no output context");
      outCtx.imageSmoothingEnabled = true;
      outCtx.imageSmoothingQuality = "high";
      const scale = targetSize / square;
      const dx = (targetSize - cropWidth * scale) / 2;
      const dy = (targetSize - cropHeight * scale) / 2;
      outCtx.drawImage(
        canvas,
        minX,
        minY,
        cropWidth,
        cropHeight,
        dx,
        dy,
        cropWidth * scale,
        cropHeight * scale,
      );
      return {
        dataUrl: out.toDataURL("image/png"),
        background: { r: Math.round(br), g: Math.round(bg), b: Math.round(bb) },
        crop: { minX, minY, cropWidth, cropHeight },
      };
    },
    { dataUrl, targetSize },
  );

  const pngBase64 = result.dataUrl.split(",")[1];
  const destinationPath = path.resolve(destination);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, Buffer.from(pngBase64, "base64"));
  console.log(
    JSON.stringify({
      destination: destinationPath,
      background: result.background,
      crop: result.crop,
    }),
  );
} finally {
  await browser.close();
}
