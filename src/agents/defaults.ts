// Defaults for agent metadata when upstream does not supply them.
// Keep this aligned with the product-level latest-model baseline.
export const DEFAULT_PROVIDER = "openai";
export const DEFAULT_MODEL = "gpt-5.5";
// Conservative fallback used when model metadata is unavailable.
export const DEFAULT_CONTEXT_TOKENS = 200_000;

/**
 * Recommended default model per provider, used when an operator places their
 * first key for a provider but has NOT configured `agents.defaults.model`. Keep
 * this aligned with the latest-model baseline above (one place to bump per
 * provider). Callers MUST validate the chosen model against the live model
 * catalog before persisting it, so a stale entry here can never write a model
 * id that no longer exists. Keys are normalized (lower-case) provider ids.
 */
export const RECOMMENDED_MODEL_BY_PROVIDER: Readonly<Record<string, string>> = {
  [DEFAULT_PROVIDER]: DEFAULT_MODEL, // openai → gpt-5.5
  anthropic: "claude-sonnet-4-6",
};

/** Recommended default model id for a provider, or undefined if none is known. */
export function resolveRecommendedModelForProvider(provider: string): string | undefined {
  return RECOMMENDED_MODEL_BY_PROVIDER[provider.trim().toLowerCase()];
}
