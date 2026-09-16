/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMesh, mountGravityFabric, waveHeight } from "./gravity-fabric.ts";

/** jsdom has no 2D context; a recording one lets the frame loop arm. */
function fakeContext() {
  return {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setTransform: vi.fn(),
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
  };
}

function createCanvas(context: ReturnType<typeof fakeContext> | null) {
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D | null,
  );
  return canvas;
}

describe("gravity fabric (vendored head 7e987ce5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("stays a static, listener-free no-op without a 2D context and reports honest stats", () => {
    const canvas = createCanvas(null);
    const listen = vi.spyOn(window, "addEventListener");
    const handle = mountGravityFabric(canvas, { theme: "dark", pointerTarget: window, energy: 7 });
    expect(handle.stats.mode).toBe("static");
    expect(handle.stats.frames).toBe(0);
    expect(handle.stats.cells).toBe(0);
    // Energy is clamped to the module's 0–4 band at mount.
    expect(handle.stats.energy).toBe(4);
    expect(listen).not.toHaveBeenCalled();
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.style.pointerEvents).toBe("none");
    handle.setTheme("light");
    handle.setEnergy(2);
    handle.setCovered(true);
    expect(handle.stats.mode).toBe("static");
    handle.destroy();
    expect(handle.stats.mode).toBe("destroyed");
    handle.setTheme("dark");
    handle.setCovered(false);
    handle.destroy();
    expect(handle.stats.mode).toBe("destroyed");
  });

  it("paints one static field under reduced motion and never schedules a frame", () => {
    const context = fakeContext();
    const canvas = createCanvas(context);
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    const handle = mountGravityFabric(canvas, {
      theme: "dark",
      pointerTarget: window,
      reducedMotion: true,
    });
    expect(handle.stats.mode).toBe("static");
    expect(handle.stats.cells).toBeGreaterThan(0);
    expect(context.stroke).toHaveBeenCalled();
    expect(raf).not.toHaveBeenCalled();
    // Reduced motion never runs the loop, so energy snaps and repaints instead of easing.
    const strokesBefore = context.stroke.mock.calls.length;
    handle.setEnergy(9);
    expect(handle.stats.energy).toBe(4);
    expect(context.stroke.mock.calls.length).toBeGreaterThan(strokesBefore);
    handle.setCovered(true);
    expect(handle.stats.mode).toBe("static");
    handle.destroy();
    expect(handle.stats.mode).toBe("destroyed");
  });

  it("goes live when motion is allowed, parks while covered, and stops its frame on destroy", () => {
    const canvas = createCanvas(fakeContext());
    const raf = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const handle = mountGravityFabric(canvas, { theme: "light", pointerTarget: window });
    expect(handle.stats.mode).toBe("live");
    expect(raf).toHaveBeenCalledOnce();
    handle.setCovered(true);
    expect(handle.stats.mode).toBe("paused");
    expect(cancel).toHaveBeenCalledWith(7);
    handle.setCovered(false);
    expect(handle.stats.mode).toBe("live");
    expect(raf).toHaveBeenCalledTimes(2);
    handle.destroy();
    expect(handle.stats.mode).toBe("destroyed");
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("scales the wave field by energy and lays a mesh for any aspect", () => {
    // Zero energy flattens the field (the product may be -0).
    expect(Math.abs(waveHeight(0.3, 2, 5, 0))).toBe(0);
    expect(Math.abs(waveHeight(0.3, 2, 5, 1))).toBeGreaterThan(0);
    expect(buildMesh(16 / 9).cells).toBeGreaterThan(0);
  });
});
