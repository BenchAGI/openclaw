// Bench agent identity treatment (UI-BRAND-CONTRACT §4.1): the per-agent
// accent, rarity halo, role line, glyph, voice, and portrait every Bench
// surface paints. Mirrors the web app's relay-visuals.ts so both products show
// the same colors. Pure data plus two helpers; no Lit, nothing rendered here.
//
// Gateway identity (name, avatar) still wins when the customer has customised
// it — this manifest only fills what the gateway does not carry.

export type BenchAgentRarity = "legendary" | "epic" | "rare" | "uncommon" | "common";

/** WoW-scale rarity ring colors shared with the web app (`--rar-*`). */
export const BENCH_RARITY_COLORS: Readonly<Record<BenchAgentRarity, string>> = {
  legendary: "#ff8000",
  epic: "#a335ee",
  rare: "#0070dd",
  uncommon: "#1eff00",
  common: "#c8ced6",
};

export type BenchAgentGlyph =
  | "feather"
  | "target"
  | "leaf"
  | "megaphone"
  | "flame"
  | "bird"
  | "shield"
  | "summit";

export type BenchAgentIdentity = {
  readonly id: string;
  /** Product display name; the gateway's configured name takes precedence. */
  readonly name: string;
  /** Role line under the name (sentence case). */
  readonly role: string;
  /** `--agent-accent`: the agent's identity color (name, ring, dot). */
  readonly accent: string;
  /** Accent for text-carrying uses on light surfaces when the dark accent
   * cannot clear AA there; falls back to `accent`. */
  readonly lightTextAccent?: string;
  readonly rarity: BenchAgentRarity;
  /** Stroke glyph drawn when no portrait exists (components/icons.ts). */
  readonly glyph: BenchAgentGlyph;
  /** Voice casting label for the switcher footer; null when uncast. */
  readonly voice: string | null;
  /** Public portrait under ui/public/agent-art; null falls back to the glyph. */
  readonly portrait: `agent-art/${string}.png` | null;
};

const BENCH_AGENTS: Readonly<Record<string, BenchAgentIdentity>> = {
  aurelius: {
    id: "aurelius",
    name: "Aurelius",
    role: "Operations",
    accent: "#e7c182",
    // #e7c182 on chalk is ≈1.7:1; role eyebrows in light mode use the bronze.
    lightTextAccent: "#8a6a2c",
    rarity: "legendary",
    glyph: "feather",
    voice: "Aurelius Young",
    portrait: "agent-art/aurelius.png",
  },
  cole: {
    id: "cole",
    name: "Zig",
    role: "Sales",
    accent: "#f59e5b",
    rarity: "epic",
    glyph: "target",
    voice: "Charlie",
    portrait: "agent-art/zig.png",
  },
  sage: {
    id: "sage",
    name: "Sage",
    role: "Customer success",
    accent: "#b79cf5",
    rarity: "epic",
    glyph: "leaf",
    voice: "Sage",
    portrait: "agent-art/sage.png",
  },
  piper: {
    id: "piper",
    name: "Piper",
    role: "Marketing",
    accent: "#7fb2e8",
    rarity: "rare",
    glyph: "megaphone",
    voice: "Bella",
    portrait: "agent-art/piper.png",
  },
  ember: {
    id: "ember",
    name: "Ember",
    role: "Field ops",
    accent: "#f5879e",
    rarity: "rare",
    glyph: "flame",
    voice: "Laura",
    portrait: "agent-art/ember.png",
  },
  bailey: {
    id: "bailey",
    name: "Bailey",
    role: "Personal",
    accent: "#93a4bc",
    rarity: "uncommon",
    glyph: "bird",
    voice: "Sarah",
    portrait: "agent-art/bailey.png",
  },
  sentinel: {
    id: "sentinel",
    name: "Sentinel",
    role: "Slack relay",
    accent: "#6fc7b8",
    rarity: "uncommon",
    glyph: "shield",
    voice: "Daniel",
    portrait: null,
  },
  epic: {
    id: "epic",
    name: "Epic",
    role: "Strategy",
    accent: "#7c82ff",
    rarity: "epic",
    glyph: "summit",
    voice: "Bill",
    portrait: "agent-art/epic.png",
  },
};

// Persona handles the web app also answers to (relay-visuals.ts aliases).
const BENCH_AGENT_ALIASES: Readonly<Record<string, string>> = {
  zig: "cole",
  sully: "piper",
  ogilvy: "piper",
};

export const BENCH_AGENT_IDS: readonly string[] = Object.keys(BENCH_AGENTS);

/** The Bench identity for an agent id, or null for any other (customer) agent. */
export function benchAgentIdentity(agentId: string | null | undefined): BenchAgentIdentity | null {
  const id = agentId?.trim().toLowerCase();
  if (!id) {
    return null;
  }
  return BENCH_AGENTS[BENCH_AGENT_ALIASES[id] ?? id] ?? null;
}

export function benchAgentRarityColor(identity: BenchAgentIdentity | null): string {
  return BENCH_RARITY_COLORS[identity?.rarity ?? "common"];
}

/** Accent safe for text on the current surface (see `lightTextAccent`). */
export function benchAgentTextAccent(
  identity: BenchAgentIdentity | null,
  lightSurface: boolean,
): string | null {
  if (!identity) {
    return null;
  }
  return lightSurface ? (identity.lightTextAccent ?? identity.accent) : identity.accent;
}

/**
 * Inline `style` value painting a subtree in the agent's accent and rarity.
 * Unknown agents inherit `--accent` and the common ring so the halo rule
 * still resolves.
 */
export function benchAgentStyle(agentId: string | null | undefined): string {
  const identity = benchAgentIdentity(agentId);
  const accent = identity?.accent ?? "var(--accent)";
  return `--agent-accent: ${accent}; --agent-rarity: ${benchAgentRarityColor(identity)};`;
}
