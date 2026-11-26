import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

const isFable = (model: string) => model.startsWith("claude-fable");

/**
 * Threads started by voice never run on Fable: spoken one-liners would spend the most expensive
 * model. A Fable default steps down to Opus on the same account (or its next non-Fable model).
 */
export function capVoiceLaunchModel(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection {
  if (!isFable(selection.model)) return selection;
  const models =
    providers.find((provider) => provider.instanceId === selection.instanceId)?.models ?? [];
  const replacement =
    models.find((model) => model.slug.startsWith("claude-opus")) ??
    models.find((model) => !isFable(model.slug));
  return { ...selection, model: replacement?.slug ?? "claude-opus-5-5" };
}
