import type { AddonEntry } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { getAddonStoreState, subscribeAddonStore } from "./addonStore";

/**
 * Operations add-ons expose to the rest of mattr (native UI, the voice assistant, MCP tools).
 * A capability exists only while an add-on that provides it is enabled, so a disabled Grok Bot
 * contributes nothing the voice assistant could call.
 */
export type MattrCapabilityId =
  | "bots.discover"
  | "bots.read"
  | "bots.message"
  | "bots.status"
  | "voice.converse"
  | "voice.briefings";

interface CapabilityDefinition {
  readonly id: MattrCapabilityId;
  readonly providedBy: (entry: AddonEntry) => boolean;
}

const isBotsProvider = (entry: AddonEntry) =>
  entry.manifest.contributions.includes("bots-provider");
const isVoiceAssistant = (entry: AddonEntry) => entry.manifest.id === "voice-assistant";

const CAPABILITIES: ReadonlyArray<CapabilityDefinition> = [
  { id: "bots.discover", providedBy: isBotsProvider },
  { id: "bots.read", providedBy: isBotsProvider },
  { id: "bots.message", providedBy: isBotsProvider },
  { id: "bots.status", providedBy: isBotsProvider },
  { id: "voice.converse", providedBy: isVoiceAssistant },
  { id: "voice.briefings", providedBy: isVoiceAssistant },
];

interface MattrCapability {
  readonly id: MattrCapabilityId;
  readonly addonIds: ReadonlyArray<string>;
}

function availableCapabilities(entries: ReadonlyArray<AddonEntry>): ReadonlyArray<MattrCapability> {
  const enabled = entries.filter((entry) => entry.state.enabled);
  return CAPABILITIES.flatMap((capability) => {
    const addonIds = enabled.filter(capability.providedBy).map((entry) => entry.manifest.id);
    return addonIds.length === 0 ? [] : [{ id: capability.id, addonIds }];
  });
}

function hasCapability(id: MattrCapabilityId): boolean {
  return availableCapabilities(getAddonStoreState().entries).some((entry) => entry.id === id);
}

export function useHasCapability(id: MattrCapabilityId): boolean {
  return useSyncExternalStore(
    subscribeAddonStore,
    () => hasCapability(id),
    () => hasCapability(id),
  );
}
