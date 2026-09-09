/* @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { GravityFabricHandle, GravityFabricOptions } from "../lib/gravity-fabric.ts";
import "./bench-gravity-fabric.ts";
import type { BenchGravityFabric } from "./bench-gravity-fabric.ts";

type HostElement = HTMLElement & BenchGravityFabric;

function createMount() {
  const handles: Array<{ destroy: ReturnType<typeof vi.fn>; setTheme: ReturnType<typeof vi.fn> }> =
    [];
  const calls: Array<{ canvas: HTMLCanvasElement; options: GravityFabricOptions }> = [];
  const mount = vi.fn((canvas: HTMLCanvasElement, options: GravityFabricOptions) => {
    calls.push({ canvas, options });
    const handle = {
      destroy: vi.fn(),
      setTheme: vi.fn(),
      stats: { mode: "live" as const },
    };
    handles.push(handle);
    return handle as unknown as GravityFabricHandle;
  });
  return { mount, calls, handles };
}

async function mountHost(patch: Partial<Pick<HostElement, "enabled" | "theme">> = {}) {
  const { mount, calls, handles } = createMount();
  const host = document.createElement("bench-gravity-fabric") as HostElement;
  host.mount = mount;
  Object.assign(host, patch);
  document.body.append(host);
  await host.updateComplete;
  return { host, mount, calls, handles };
}

describe("bench-gravity-fabric host", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("stays dormant until the host enables it", async () => {
    const { host, mount } = await mountHost();
    expect(host.querySelector("canvas.bench-gravity-fabric")).not.toBeNull();
    expect(mount).not.toHaveBeenCalled();
    expect(host.stats).toBeNull();
  });

  it("mounts the module on its canvas with the resolved theme and the window as pointer target", async () => {
    const { host, calls, handles } = await mountHost({ enabled: true, theme: "light" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.canvas).toBe(host.querySelector("canvas.bench-gravity-fabric"));
    expect(calls[0]?.options).toMatchObject({
      theme: "light",
      pointerTarget: window,
      reducedMotion: false,
    });
    host.theme = "dark";
    await host.updateComplete;
    expect(handles[0]?.setTheme).toHaveBeenCalledWith("dark");
    expect(host.stats).toEqual({ mode: "live" });
  });

  it("destroys the module when disabled and again when removed", async () => {
    const { host, handles, calls } = await mountHost({ enabled: true });
    host.enabled = false;
    await host.updateComplete;
    expect(handles[0]?.destroy).toHaveBeenCalledOnce();
    expect(host.stats).toBeNull();
    host.enabled = true;
    await host.updateComplete;
    expect(calls).toHaveLength(2);
    host.remove();
    expect(handles[1]?.destroy).toHaveBeenCalledOnce();
  });
});
