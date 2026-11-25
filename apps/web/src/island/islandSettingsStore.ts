import { useSyncExternalStore } from "react";
import {
  DEFAULT_ISLAND_SETTINGS,
  type IslandSettings,
  type IslandShortcutMode,
} from "../../../../antimatter/island/types";

const STORAGE_KEY = "mattr:island:settings:v1";

const VALID_SHORTCUTS = new Set<IslandShortcutMode>([
  "control",
  "option",
  "command-shift-space",
  "off",
]);

function readStoredSettings(): IslandSettings {
  if (typeof window === "undefined") return DEFAULT_ISLAND_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ISLAND_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<IslandSettings>;
    return {
      enabled:
        typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_ISLAND_SETTINGS.enabled,
      shortcut:
        typeof parsed.shortcut === "string" &&
        VALID_SHORTCUTS.has(parsed.shortcut as IslandShortcutMode)
          ? (parsed.shortcut as IslandShortcutMode)
          : DEFAULT_ISLAND_SETTINGS.shortcut,
      showNotifications:
        typeof parsed.showNotifications === "boolean"
          ? parsed.showNotifications
          : DEFAULT_ISLAND_SETTINGS.showNotifications,
      showMessages:
        typeof parsed.showMessages === "boolean"
          ? parsed.showMessages
          : DEFAULT_ISLAND_SETTINGS.showMessages,
    };
  } catch {
    return DEFAULT_ISLAND_SETTINGS;
  }
}

let currentSettings: IslandSettings = readStoredSettings();
const listeners = new Set<() => void>();

export function getIslandSettings(): IslandSettings {
  return currentSettings;
}

function subscribeIslandSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateIslandSettings(patch: Partial<IslandSettings>): IslandSettings {
  const next: IslandSettings = { ...currentSettings, ...patch };
  currentSettings = next;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
    void window.desktopBridge?.island?.updateSettings(next).catch(() => undefined);
  }
  for (const listener of listeners) listener();
  return next;
}

export function useIslandSettings(): IslandSettings {
  return useSyncExternalStore(
    subscribeIslandSettings,
    getIslandSettings,
    () => DEFAULT_ISLAND_SETTINGS,
  );
}
