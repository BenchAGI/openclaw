import { t } from "../../../i18n/index.ts";
import type { ChatModelPickerOption } from "./chat-model-picker-options.ts";

type ProviderGroup = [provider: string, options: ChatModelPickerOption[]];

function isBenchProvider(provider: string): boolean {
  return provider === "bench" || provider === "benchagi";
}

/** Put Bench-backed models first and label the two provider sections when both exist. */
export function applyBenchProviderSections(
  orderedProviderGroups: ProviderGroup[],
): Map<string, string> {
  const benchProviderGroups = orderedProviderGroups.filter(([provider]) =>
    isBenchProvider(provider),
  );
  if (benchProviderGroups.length === 0) {
    return new Map();
  }
  orderedProviderGroups.splice(
    0,
    orderedProviderGroups.length,
    ...benchProviderGroups,
    ...orderedProviderGroups.filter(([provider]) => !isBenchProvider(provider)),
  );
  const labels = new Map<string, string>();
  labels.set(benchProviderGroups[0]![0], t("chat.modelControls.benchModels"));
  const firstOwnKeys = orderedProviderGroups.find(([provider]) => !isBenchProvider(provider));
  if (firstOwnKeys) {
    labels.set(firstOwnKeys[0], t("chat.modelControls.yourOwnKeys"));
  }
  return labels;
}
