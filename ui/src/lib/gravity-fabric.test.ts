/* @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";
import { mountGravityFabric } from "./gravity-fabric.ts";

describe("gravity fabric stub", () => {
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
