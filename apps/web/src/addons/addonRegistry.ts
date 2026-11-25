import type { AddonManifest, AddonRuntimeStatusKind } from "@t3tools/contracts";
import { BotIcon, CloudIcon, MicIcon, PuzzleIcon } from "lucide-react";
import { msg } from "gt-react";
import type { ComponentType } from "react";

/** Translated copy and icons for add-ons; the manifest's English is the fallback. */
interface AddonPresentation {
  readonly title: string;
  readonly description: string;
  readonly Icon: ComponentType<{ className?: string }>;
  /** Status wording specific to this add-on, over the generic labels. */
  readonly statusLabels?: Readonly<Partial<Record<AddonRuntimeStatusKind, string>>>;
}

const ADDON_PRESENTATION: Readonly<Record<string, AddonPresentation>> = {
  "grok-bot": {
    title: msg("Grok Bot"),
    description: msg("Talk to your existing Grok Bot teammates from the mattr sidebar."),
    Icon: BotIcon,
    statusLabels: {
      connected: msg("Connected"),
      enabled_unconfigured: msg("Needs debug port"),
      app_unavailable: msg("Grok Bot app not installed"),
    },
  },
  "voice-assistant": {
    title: msg("Voice Assistant"),
    description: msg(
      "A hands-free assistant that can summarize threads, report progress and steer your agents.",
    ),
    Icon: MicIcon,
  },
  "claude-cloud": {
    title: msg("Claude Cloud"),
    description: msg(
      "Offload heavy work to Claude Cloud VMs on your Claude subscription, send follow-ups, and pull sessions back into local worktree threads.",
    ),
    Icon: CloudIcon,
    statusLabels: {
      enabled_unconfigured: msg("Check accounts"),
      auth_required: msg("Needs a claude.ai login"),
    },
  },
};

export function addonPresentation(manifest: AddonManifest): AddonPresentation {
  return (
    ADDON_PRESENTATION[manifest.id] ?? {
      title: manifest.displayName,
      description: manifest.description,
      Icon: PuzzleIcon,
    }
  );
}

export const ADDON_STATUS_LABELS: Readonly<Record<AddonRuntimeStatusKind, string>> = {
  disabled: msg("Off"),
  enabled_unconfigured: msg("Needs setup"),
  app_unavailable: msg("App not running"),
  connecting: msg("Connecting"),
  connected: msg("Ready"),
  disconnected: msg("Disconnected"),
  auth_required: msg("Sign-in required"),
  incompatible_version: msg("Update required"),
  error: msg("Error"),
};
