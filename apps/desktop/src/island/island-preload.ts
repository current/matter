import { contextBridge, ipcRenderer, webUtils } from "electron";
import {
  ISLAND_ACTION_CHANNEL,
  ISLAND_ANIMATION_IDLE_CHANNEL,
  ISLAND_CONTEXT_MENU_CHANNEL,
  ISLAND_DISPLAY_METRICS_CHANNEL,
  ISLAND_EXPAND_REQUEST_CHANNEL,
  ISLAND_FOCUS_WINDOW_CHANNEL,
  ISLAND_RELEASE_FOCUS_CHANNEL,
  ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL,
  ISLAND_SNAPSHOT_CHANNEL,
  type IslandAction,
  type IslandDisplayMetrics,
  type IslandSnapshot,
  type IslandWindowCommand,
} from "../../../../antimatter/island/types.ts";

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
    if (typeof value === "object" && value !== null) listener(value as T);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld("mattrIsland", {
  onSnapshot: (listener: (snapshot: IslandSnapshot) => void) =>
    subscribe(ISLAND_SNAPSHOT_CHANNEL, listener),
  onCommand: (listener: (command: IslandWindowCommand) => void) =>
    subscribe(ISLAND_EXPAND_REQUEST_CHANNEL, listener),
  onDisplayMetrics: (listener: (metrics: IslandDisplayMetrics) => void) =>
    subscribe(ISLAND_DISPLAY_METRICS_CHANNEL, listener),
  sendAction: (action: IslandAction) => {
    ipcRenderer.send(ISLAND_ACTION_CHANNEL, action);
  },
  setMousePassthrough: (ignore: boolean) => {
    ipcRenderer.send(ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL, ignore);
  },
  /** Keys the island without activating Matter, so the current app keeps its Space. */
  focusWindow: () => {
    ipcRenderer.send(ISLAND_FOCUS_WINDOW_CHANNEL);
  },
  /** Gives keyboard focus back to the app the user was in. */
  releaseFocus: () => {
    ipcRenderer.send(ISLAND_RELEASE_FOCUS_CHANNEL);
  },
  showContextMenu: () => {
    ipcRenderer.send(ISLAND_CONTEXT_MENU_CHANNEL);
  },
  notifyAnimationIdle: () => {
    ipcRenderer.send(ISLAND_ANIMATION_IDLE_CHANNEL);
  },
  /** Absolute path of a dropped file; sandboxed renderers can't read `File.path`. */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
});
