import { contextBridge, ipcRenderer } from "electron";
import {
  ISLAND_ACTION_CHANNEL,
  ISLAND_ANIMATION_IDLE_CHANNEL,
  ISLAND_CONTEXT_MENU_CHANNEL,
  ISLAND_DISPLAY_METRICS_CHANNEL,
  ISLAND_EXPAND_REQUEST_CHANNEL,
  ISLAND_FOCUS_WINDOW_CHANNEL,
  ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL,
  ISLAND_SNAPSHOT_CHANNEL,
  type IslandAction,
  type IslandDisplayMetrics,
  type IslandSnapshot,
  type IslandWindowCommand,
} from "../../../../antimatter/island/types.ts";

contextBridge.exposeInMainWorld("mattrIsland", {
  onSnapshot: (listener: (snapshot: IslandSnapshot) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown) => {
      if (typeof snapshot === "object" && snapshot !== null) {
        listener(snapshot as IslandSnapshot);
      }
    };
    ipcRenderer.on(ISLAND_SNAPSHOT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ISLAND_SNAPSHOT_CHANNEL, handler);
  },
  onCommand: (listener: (command: IslandWindowCommand) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, command: unknown) => {
      if (typeof command === "object" && command !== null) {
        listener(command as IslandWindowCommand);
      }
    };
    ipcRenderer.on(ISLAND_EXPAND_REQUEST_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ISLAND_EXPAND_REQUEST_CHANNEL, handler);
  },
  onDisplayMetrics: (listener: (metrics: IslandDisplayMetrics) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, metrics: unknown) => {
      if (typeof metrics === "object" && metrics !== null) {
        listener(metrics as IslandDisplayMetrics);
      }
    };
    ipcRenderer.on(ISLAND_DISPLAY_METRICS_CHANNEL, handler);
    return () => ipcRenderer.removeListener(ISLAND_DISPLAY_METRICS_CHANNEL, handler);
  },
  sendAction: (action: IslandAction) => {
    ipcRenderer.send(ISLAND_ACTION_CHANNEL, action);
  },
  setMousePassthrough: (ignore: boolean) => {
    ipcRenderer.send(ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL, ignore);
  },
  focusWindow: () => {
    ipcRenderer.send(ISLAND_FOCUS_WINDOW_CHANNEL);
  },
  showContextMenu: () => {
    ipcRenderer.send(ISLAND_CONTEXT_MENU_CHANNEL);
  },
  notifyAnimationIdle: () => {
    ipcRenderer.send(ISLAND_ANIMATION_IDLE_CHANNEL);
  },
});
