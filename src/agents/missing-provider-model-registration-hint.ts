/**
 * Shared wording for the "this provider model is registered nowhere" recovery
 * hint. Model resolution raises it as an error at run time; config validation
 * raises it as a warning at load time, so both must say the same thing.
 */

/** Build the recovery hint for a provider/model no provider catalog registers. */
export function formatMissingProviderModelRegistrationHint(params: {
  provider: string;
  modelId: string;
  agentModelKey?: string;
}): string {
  const missing = params.agentModelKey
    ? `Found agents.defaults.models["${params.agentModelKey}"], but no matching models.providers["${params.provider}"].models[] entry.`
    : `No models.providers["${params.provider}"].models[] entry registers this model.`;
  return `${missing} Add { "id": "${params.modelId}", "name": "${params.modelId}" } to models.providers["${params.provider}"].models[] to register this provider model. For custom or proxy providers, also set api and baseUrl so requests route to the intended endpoint. See https://docs.openclaw.ai/concepts/model-providers.`;
}
