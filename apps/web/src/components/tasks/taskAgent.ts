import { isReasoningSelect } from "@t3tools/client-runtime/model-traits";
import type {
  ModelSelection,
  ProviderOptionChoice,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";

export interface TaskAgentChoice {
  readonly provider: ServerProvider;
  readonly model: ServerProviderModel;
  readonly effortOptionId: string | null;
  readonly effortChoices: ReadonlyArray<ProviderOptionChoice>;
  readonly effort: string | null;
}

/** Providers a task can be handed to: on, installed, signed in and offering a model. */
export function usableTaskProviders(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  return providers.filter(
    (provider) =>
      provider.enabled &&
      provider.installed &&
      provider.status !== "disabled" &&
      provider.status !== "error" &&
      provider.auth.status !== "unauthenticated" &&
      provider.models.some((model) => !model.isLegacy),
  );
}

const visibleModels = (provider: ServerProvider) =>
  provider.models.filter((model) => !model.isLegacy);

export function taskProviderModels(provider: ServerProvider) {
  return visibleModels(provider);
}

const defaultModel = (provider: ServerProvider) =>
  visibleModels(provider).find((model) => model.isDefault) ?? visibleModels(provider)[0];

/**
 * The agent a task starts with: its own choice when that provider is still usable, else the
 * project's default model, else the first usable provider's default.
 */
export function resolveTaskAgentChoice(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly defaultSelection: ModelSelection | null;
}): TaskAgentChoice | null {
  const usable = usableTaskProviders(input.providers);
  const pick = (instanceId: string | null, modelSlug: string | null) => {
    const provider = usable.find((candidate) => candidate.instanceId === instanceId);
    if (!provider) return null;
    const model =
      visibleModels(provider).find((candidate) => candidate.slug === modelSlug) ??
      defaultModel(provider);
    return model ? { provider, model } : null;
  };
  const chosen =
    pick(input.providerInstanceId, input.model) ??
    pick(input.defaultSelection?.instanceId ?? null, input.defaultSelection?.model ?? null) ??
    (usable[0] ? pick(usable[0].instanceId, null) : null);
  if (!chosen) return null;
  const descriptor = chosen.model.capabilities?.optionDescriptors?.find(isReasoningSelect) ?? null;
  const effortChoices = descriptor?.options ?? [];
  const effort =
    effortChoices.find((choice) => choice.id === input.effort)?.id ??
    effortChoices.find((choice) => choice.id === descriptor?.currentValue)?.id ??
    effortChoices.find((choice) => choice.isDefault)?.id ??
    null;
  return {
    ...chosen,
    effortOptionId: descriptor?.id ?? null,
    effortChoices,
    effort,
  };
}

export function taskModelSelection(choice: TaskAgentChoice): ModelSelection {
  return {
    instanceId: choice.provider.instanceId,
    model: choice.model.slug,
    ...(choice.effortOptionId !== null && choice.effort !== null
      ? { options: [{ id: choice.effortOptionId, value: choice.effort }] }
      : {}),
  };
}

export function providerLabel(provider: ServerProvider): string {
  return provider.displayName ?? provider.instanceId;
}

export function modelLabel(model: ServerProviderModel): string {
  return model.shortName ?? model.name;
}
