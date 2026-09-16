/**
 * Gravity fabric — vendored from BenchAGI/aurelius
 * `apps/aurelius-vault/app/src/gravity-fabric.ts` at
 * 7e987ce5c4e7a81baae5b750a262d8cf0ccf9a0c (branch feat/vault-design-hero,
 * 2026-09-16, "fabric energy multiplier and a native-child pause"), the head
 * Cory accepted for UI-BRAND-CONTRACT §8. Dependency-free Canvas2D ESM.
 *
 * The body below this header is that commit's text. oxfmt and oxlint skip
 * this file (.oxfmtrc.jsonc / .oxlintrc.json) so a diff against the Vault
 * source stays readable; the only fork deltas are the `// fork:` lines: `?? 0`
 * on typed-array and trail reads whose indexes are always in range (the
 * fork's `noUncheckedIndexedAccess`) and one `// SAFETY:` line for the fork's
 * type-assertion ratchet. To re-vendor: copy the accepted head over the body,
 * re-apply those lines, update the sha above.
 *
 * Host notes (components/bench-gravity-fabric.ts): `readTokens` is accepted
 * for API compatibility but this head paints its own per-theme edge and
 * sprite colours; without a 2D context the mount is a static, listener-free
 * no-op whose stats still report honestly; the mount pins its canvas inline
 * (position/inset/size/z-index), which the host reconciles with
 * styles/bench-gravity-fabric.css.
 */
/** One continuous perspective honeycomb, travelling wave packets and passing sprites.
 * Geometry never changes resolution with depth: every edge belongs to the same
 * world-space lattice. Distance fades subpixel detail instead of replacing it.
 */
export type FabricTheme = "dark" | "light";
export interface FabricTokens {
  bg: string;
  ir: string;
}
export interface GravityFabricOptions {
  theme: FabricTheme;
  pointerTarget: Window | HTMLElement;
  reducedMotion?: boolean;
  /** Initial wave/edge energy (1 = nominal). Later changes ease via setEnergy. */
  energy?: number;
  readTokens?: (theme: FabricTheme) => FabricTokens;
}
export interface FabricStats {
  frames: number;
  averageFrameMs: number;
  p50FrameMs: number;
  p95FrameMs: number;
  fps: number;
  cells: number;
  levels: number;
  rings: number;
  trails: boolean;
  /** Current (eased) energy multiplier applied to wave amplitude and edge alpha. */
  energy: number;
  mode: "static" | "live" | "paused" | "destroyed";
}
export interface GravityFabricHandle {
  destroy(): void;
  setTheme(theme: FabricTheme): void;
  /** Ease the energy multiplier toward `value` over ~ENERGY_EASE_SECONDS. */
  setEnergy(value: number): void;
  /** A native child webview paints over the shell: park the loop exactly like
   * a blurred or hidden document, and wake when the child is hidden again. */
  setCovered(covered: boolean): void;
  readonly stats: FabricStats;
}
export const HEX_RADIUS = 0.085;
export const HEX_WIDTH = Math.sqrt(3) * HEX_RADIUS;
export const ROW_PITCH = 1.5 * HEX_RADIUS;
export const FAR_DEPTH = 12;
export const HORIZON = 0.07;
export const CAMERA_HEIGHT = 0.95;
export const DRIFT_SPEED = 0.042;
export const WAVE_CYCLE = 30;
export const SPRITE_COUNT = 5;
/** Energy eases with a 0.5 s time constant: ~95% of the way in 1.5 s. */
export const ENERGY_EASE_SECONDS = 1.5;
const ENERGY_TAU = ENERGY_EASE_SECONDS / 3;
export function easeEnergy(current: number, target: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-dt / ENERGY_TAU));
}
const clamp = (n: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, n));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export interface Mesh {
  x: Float32Array;
  z: Float32Array;
  edges: Uint32Array;
  cells: number;
}
/** Integer lattice keys make neighbours share exactly the same vertices/edges. */
export function buildMesh(aspect: number): Mesh {
  const xs: number[] = [],
    zs: number[] = [],
    edges: number[] = [];
  const vertices = new Map<string, number>(),
    seen = new Set<string>();
  let cells = 0;
  const vertex = (x: number, z: number) => {
    const key = `${x},${z}`;
    const found = vertices.get(key);
    if (found !== undefined) return found;
    const index = xs.length;
    vertices.set(key, index);
    xs.push((x * HEX_WIDTH) / 2);
    zs.push(0.7 + (z * HEX_RADIUS) / 2);
    return index;
  };
  for (let row = 0; 0.7 + row * ROW_PITCH < FAR_DEPTH; row++) {
    const z = 0.7 + row * ROW_PITCH;
    const half = Math.ceil(
      ((z * Math.max(0.3, aspect)) / 2 + HEX_WIDTH * 2) / HEX_WIDTH,
    );
    for (let col = -half; col <= half; col++) {
      const x = 2 * col + (row & 1),
        y = row * 3;
      const ids = [
        [x, y - 2],
        [x + 1, y - 1],
        [x + 1, y + 1],
        [x, y + 2],
        [x - 1, y + 1],
        [x - 1, y - 1],
      ].map(([a, b]) => vertex(a ?? 0, b ?? 0)); // fork: noUncheckedIndexedAccess
      for (let i = 0; i < 6; i++) {
        const a = ids[i] ?? 0, // fork: noUncheckedIndexedAccess
          b = ids[(i + 1) % 6] ?? 0;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        if (!seen.has(key)) {
          seen.add(key);
          edges.push(a, b);
        }
      }
      cells++;
    }
  }
  return {
    x: new Float32Array(xs),
    z: new Float32Array(zs),
    edges: new Uint32Array(edges),
    cells,
  };
}

/** Distant wave packets cross the plane, then leave a quiet interval each cycle.
 * `energy` scales the whole field (1 = nominal); the unlock entrance mounts hot. */
export function waveHeight(x: number, z: number, time: number, energy = 1): number {
  const cycle = Math.floor(time / WAVE_CYCLE);
  const t = time - cycle * WAVE_CYCLE;
  // The tiny underlying swell continues through calm periods.
  let h = 0.004 * Math.sin(z * 0.65 - time * 0.35 + x * 0.12);
  const cycleEnergy = 0.72 + 0.28 * Math.sin(cycle * 1.71 + 0.4);
  for (let pulse = 0; pulse < 3; pulse++) {
    const age = t - pulse * 2.1;
    if (age < 0 || age > 16) continue;
    const front = FAR_DEPTH - age * 0.9;
    const distance = z - front + 0.12 * Math.sin(x * 0.5 + pulse);
    const envelope = Math.exp((-distance * distance) / 1.3);
    const life = smooth(0, 1.5, age) * (1 - smooth(12, 16, age));
    h +=
      0.065 *
      cycleEnergy *
      (1 - pulse * 0.17) *
      envelope *
      Math.cos(distance * 4.8) *
      life;
  }
  return h * energy;
}

export interface Sprite {
  x: number;
  z: number;
  vx: number;
  vz: number;
  age: number;
  seed: number;
  trail: number[];
}
export function spriteRoute(seed: number, age: number): [number, number] {
  const t = age / 18;
  const side = seed % 2 ? -1 : 1;
  // An incoming pass, a broad turn below the viewer, then an outbound arc.
  const z = 1.0 + 10.5 * Math.pow(Math.cos(Math.PI * t), 2);
  const x =
    side * (0.3 + 0.42 * seed + 1.3 * Math.sin(Math.PI * t)) +
    0.55 * Math.sin(2 * Math.PI * t + seed);
  return [x, z];
}
export function createSprites(): Sprite[] {
  return Array.from({ length: SPRITE_COUNT }, (_, seed) => {
    const age = (seed * 18) / SPRITE_COUNT;
    const [x, z] = spriteRoute(seed, age);
    return { x, z, vx: 0, vz: 0, age, seed, trail: [] };
  });
}
export function stepSprites(
  sprites: Sprite[],
  dt: number,
  pointer: { x: number; z: number; strength: number } | null,
): void {
  // Substeps keep gravitational deflection stable on slow and fast displays.
  const steps = Math.max(1, Math.ceil(dt * 120)),
    step = dt / steps;
  for (let n = 0; n < steps; n++)
    for (const s of sprites) {
      s.age += step;
      if (s.age >= 18) {
        s.age %= 18;
        [s.x, s.z] = spriteRoute(s.seed, s.age);
        s.vx = 0;
        s.vz = 0;
        s.trail.length = 0;
      }
      const [tx, tz] = spriteRoute(s.seed, s.age);
      let ax = (tx - s.x) * 2.2 - s.vx * 1.2,
        az = (tz - s.z) * 2.2 - s.vz * 1.2;
      if (pointer) {
        const dx = pointer.x - s.x,
          dz = pointer.z - s.z;
        const force =
          (0.7 * pointer.strength) / Math.pow(dx * dx + dz * dz + 0.55, 1.5);
        ax += clamp(dx * force, -0.7, 0.7);
        az += clamp(dz * force, -0.7, 0.7);
      }
      s.vx = clamp(s.vx + ax * step, -3, 3);
      s.vz = clamp(s.vz + az * step, -3, 3);
      s.x += s.vx * step;
      s.z = Math.max(0.65, s.z + s.vz * step);
    }
}

export function projectPoint(
  x: number,
  z: number,
  lift: number,
  width: number,
  height: number,
): [number, number] {
  return [
    width / 2 + (height * x) / z,
    height * (HORIZON + (CAMERA_HEIGHT - lift) / z),
  ];
}

export function mountGravityFabric(
  canvas: HTMLCanvasElement,
  options: GravityFabricOptions,
): GravityFabricHandle {
  const win = canvas.ownerDocument.defaultView ?? window,
    doc = canvas.ownerDocument;
  const ctx = canvas.getContext("2d");
  const media = win.matchMedia?.("(prefers-reduced-motion: reduce)");
  let reduced = Boolean(options.reducedMotion || media?.matches);
  const stats: FabricStats = {
    frames: 0,
    averageFrameMs: 0,
    p50FrameMs: 0,
    p95FrameMs: 0,
    fps: 0,
    cells: 0,
    levels: 1,
    rings: 0,
    trails: true,
    energy: clamp(options.energy ?? 1, 0, 4),
    mode: "static",
  };
  Object.assign(canvas.style, {
    position: "fixed",
    inset: "0",
    width: "100%",
    height: "100%",
    pointerEvents: "none",
    zIndex: "0",
  });
  canvas.setAttribute("aria-hidden", "true");
  let destroyed = false,
    theme = options.theme,
    width = 1,
    height = 1,
    dpr = 1,
    time = 0,
    last = 0,
    raf = 0,
    slow = false;
  let mesh: Mesh = {
    x: new Float32Array(),
    z: new Float32Array(),
    edges: new Uint32Array(),
    cells: 0,
  };
  let px = new Float32Array(),
    py = new Float32Array(),
    alpha = new Float32Array();
  let pointerX = 0,
    pointerY = 0,
    pointerActive = false,
    wellX = 0,
    wellZ = 3,
    strength = 0;
  let focused = true,
    covered = false,
    trailTime = 0;
  let energyTarget = stats.energy;
  const sprites = createSprites(),
    costs: number[] = [];
  const stop = () => {
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    last = 0;
  };
  const draw = () => {
    if (!ctx || destroyed) return;
    ctx.clearRect(0, 0, width, height);
    const drift = reduced ? 0 : (time * DRIFT_SPEED) % (2 * ROW_PITCH);
    for (let i = 0; i < mesh.x.length; i++) {
      let x = mesh.x[i] ?? 0, // fork: noUncheckedIndexedAccess
        z = (mesh.z[i] ?? 0) - drift;
      const dx = x - wellX,
        dz = z - wellZ;
      const well = Math.exp(-(dx * dx + dz * dz) / 1.1) * strength;
      x -= dx * well * 0.008;
      const lift = reduced ? 0 : waveHeight(x, z, time, stats.energy) - 0.012 * well;
      px[i] = width / 2 + (height * x) / z;
      py[i] = height * (HORIZON + (CAMERA_HEIGHT - lift) / z);
      // Fade only: no coarse grids, resolution boundaries, or overlapping LOD.
      alpha[i] = (1 - smooth(5.5, FAR_DEPTH, z)) * smooth(0.5, 1, z);
    }
    for (let bucket = 0; bucket < 6; bucket++) {
      ctx.beginPath();
      for (let e = 0; e < mesh.edges.length; e += 2) {
        const a = mesh.edges[e] ?? 0, // fork: noUncheckedIndexedAccess (this block)
          b = mesh.edges[e + 1] ?? 0;
        const ax = px[a] ?? 0,
          ay = py[a] ?? 0,
          bx = px[b] ?? 0,
          by = py[b] ?? 0;
        if (Math.min(5, Math.floor(((alpha[a] ?? 0) + (alpha[b] ?? 0)) * 3)) !== bucket)
          continue;
        if (
          (ax < -20 && bx < -20) ||
          (ax > width + 20 && bx > width + 20) ||
          (ay > height + 20 && by > height + 20)
        )
          continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
      }
      const edgeAlpha = Math.min(
        1,
        (theme === "dark" ? 0.015 + bucket * 0.018 : 0.02 + bucket * 0.02) * stats.energy,
      );
      ctx.strokeStyle =
        theme === "dark"
          ? `rgba(177,199,215,${edgeAlpha})`
          : `rgba(40,60,75,${edgeAlpha})`;
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    if (!reduced)
      for (const s of sprites) {
        const opacity =
          smooth(0, 1.5, s.age) *
          (1 - smooth(16, 18, s.age)) *
          (1 - smooth(7, FAR_DEPTH, s.z));
        if (opacity < 0.005) continue;
        const rgb = s.seed % 2 ? "110,174,203" : "231,166,91";
        ctx.beginPath();
        for (let j = 0; j < s.trail.length; j += 2) {
          const [x, y] = projectPoint(
            s.trail[j] ?? 0, // fork: noUncheckedIndexedAccess
            s.trail[j + 1] ?? 0,
            0.045,
            width,
            height,
          );
          if (j === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = `rgba(${rgb},${opacity * 0.25})`;
        ctx.lineWidth = 1;
        ctx.stroke();
        const [x, y] = projectPoint(s.x, s.z, 0.045, width, height);
        const radius = clamp((height * 0.003) / s.z, 0.65, 2.2);
        ctx.beginPath();
        ctx.arc(x, y, radius * 3, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${opacity * 0.055})`;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${rgb},${opacity * 0.72})`;
        ctx.fill();
      }
  };
  const frame = (now: number) => {
    raf = 0;
    if (destroyed || reduced || doc.hidden || !focused || covered) return;
    if (slow && last && now - last < 1000 / 30) {
      raf = win.requestAnimationFrame(frame);
      return;
    }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
    last = now;
    time += dt;
    if (stats.energy !== energyTarget) {
      stats.energy = easeEnergy(stats.energy, energyTarget, dt);
      if (Math.abs(stats.energy - energyTarget) < 0.002) stats.energy = energyTarget;
    }
    const start = win.performance.now();
    const targetZ = clamp(
      CAMERA_HEIGHT / Math.max(0.09, pointerY / height - HORIZON),
      0.8,
      FAR_DEPTH,
    );
    const targetX = ((pointerX - width / 2) * targetZ) / height;
    const follow = 1 - Math.exp(-dt * 2);
    wellX += (targetX - wellX) * follow;
    wellZ += (targetZ - wellZ) * follow;
    strength += ((pointerActive ? 1 : 0) - strength) * follow;
    stepSprites(
      sprites,
      dt,
      strength > 0.001 ? { x: wellX, z: wellZ, strength } : null,
    );
    trailTime += dt;
    if (trailTime >= 1 / 30) {
      trailTime = 0;
      for (const s of sprites) {
        s.trail.push(s.x, s.z);
        if (s.trail.length > 36) s.trail.splice(0, 2);
      }
    }
    draw();
    costs.push(win.performance.now() - start);
    if (costs.length > 120) costs.shift();
    stats.frames++;
    stats.fps = 1 / dt;
    if (stats.frames % 30 === 0) {
      const sorted = [...costs].sort((a, b) => a - b);
      stats.averageFrameMs = costs.reduce((a, b) => a + b, 0) / costs.length;
      stats.p50FrameMs = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
      stats.p95FrameMs = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      slow = stats.averageFrameMs > 8;
    }
    stats.mode = "live";
    raf = win.requestAnimationFrame(frame);
  };
  const wake = () => {
    if (!destroyed && ctx && !reduced && !doc.hidden && focused && !covered && !raf) {
      stats.mode = "live";
      raf = win.requestAnimationFrame(frame);
    }
  };
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    width = Math.max(1, rect.width || win.innerWidth);
    height = Math.max(1, rect.height || win.innerHeight);
    dpr = Math.min(1.5, win.devicePixelRatio || 1);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    mesh = buildMesh(width / height);
    px = new Float32Array(mesh.x.length);
    py = new Float32Array(mesh.x.length);
    alpha = new Float32Array(mesh.x.length);
    stats.cells = mesh.cells;
    draw();
    wake();
  };
  const move = (event: Event) => {
    // SAFETY: registered for pointermove only, which dispatches PointerEvent. (fork: assertion ratchet)
    const p = event as PointerEvent;
    pointerX = p.clientX;
    pointerY = p.clientY;
    pointerActive = true;
  };
  const leave = () => {
    pointerActive = false;
  };
  const visibility = () => {
    if (doc.hidden) {
      stop();
      stats.mode = "paused";
    } else wake();
  };
  const blur = () => {
    focused = false;
    pointerActive = false;
    stop();
    stats.mode = "paused";
  };
  const focus = () => {
    focused = true;
    wake();
  };
  const motion = () => {
    reduced = Boolean(options.reducedMotion || media?.matches);
    stop();
    stats.mode = reduced ? "static" : "paused";
    draw();
    wake();
  };
  if (ctx) {
    resize();
    options.pointerTarget.addEventListener("pointermove", move, {
      passive: true,
    });
    options.pointerTarget.addEventListener("pointerleave", leave);
    win.addEventListener("resize", resize);
    win.addEventListener("blur", blur);
    win.addEventListener("focus", focus);
    doc.addEventListener("visibilitychange", visibility);
    media?.addEventListener?.("change", motion);
  }
  return {
    stats,
    setTheme(value) {
      theme = value;
      draw();
    },
    setEnergy(value) {
      energyTarget = clamp(value, 0, 4);
      // Reduced motion never runs the frame loop, so the eased value would
      // otherwise stick: snap and repaint the static field instead.
      if (reduced) {
        stats.energy = energyTarget;
        draw();
      }
    },
    setCovered(value) {
      if (covered === value) return;
      covered = value;
      if (covered) {
        pointerActive = false;
        stop();
        if (!destroyed && stats.mode !== "static") stats.mode = "paused";
      } else {
        wake();
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      options.pointerTarget.removeEventListener("pointermove", move);
      options.pointerTarget.removeEventListener("pointerleave", leave);
      win.removeEventListener("resize", resize);
      win.removeEventListener("blur", blur);
      win.removeEventListener("focus", focus);
      doc.removeEventListener("visibilitychange", visibility);
      media?.removeEventListener?.("change", motion);
      stats.mode = "destroyed";
    },
  };
}
