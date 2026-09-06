/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { defaultTokens, mountGravityFabric } from "./gravity-fabric.ts";

describe("gravity fabric stub", () => {
  it("falls back to the Bench tokens when the theme exposes none", () => {
    expect(defaultTokens("dark", null)).toEqual({ bg: "#0a0a0c", ir: "#ff2d55" });
    expect(defaultTokens("light", null)).toEqual({ bg: "#fafaf7", ir: "#d40f3f" });
  });

  it("reads --bg and --brand-bench off the element it is given", () => {
    const root = document.createElement("div");
    root.style.setProperty("--bg", "#07070a");
    root.style.setProperty("--brand-bench", "#e7c182");
    document.body.append(root);
    expect(defaultTokens("dark", root)).toEqual({ bg: "#07070a", ir: "#e7c182" });
    root.remove();
  });

  it("mounts as a static, pointer-free layer and is a harmless no-op without a 2D context", () => {
    const canvas = document.createElement("canvas");
    vi.spyOn(canvas, "getContext").mockReturnValue(null);
    const readTokens = vi.fn(() => ({ bg: "#000000", ir: "#ff2d55" }));
    const handle = mountGravityFabric(canvas, { theme: "dark", pointerTarget: window, readTokens });
    expect(handle.stats.mode).toBe("static");
    expect(handle.stats.frames).toBe(0);
    handle.setTheme("light");
    expect(readTokens).toHaveBeenLastCalledWith("light");
    handle.destroy();
    expect(handle.stats.mode).toBe("destroyed");
    handle.setTheme("dark");
    expect(handle.stats.mode).toBe("destroyed");
  });
});
