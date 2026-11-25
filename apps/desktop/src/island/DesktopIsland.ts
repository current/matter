// @effect-diagnostics globalTimers:off -- Electron IPC hide-fallback timer runs outside Effect fibers.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { startMacSingleTapModifierMonitor } from "../../../../antimatter/island/MacControlTapMonitor.ts";
import { buildIslandHtml } from "../../../../antimatter/island/islandHtml.ts";
import { shouldKeepIslandWindowAlive } from "../../../../antimatter/island/islandVisibility.ts";
import {
  DEFAULT_ISLAND_SETTINGS,
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
  type IslandSettings,
  type IslandSnapshot,
  type IslandWindowCommand,
} from "../../../../antimatter/island/types.ts";

const ISLAND_WINDOW_WIDTH = 560;
const ISLAND_WINDOW_HEIGHT = 600;
const ISLAND_FALLBACK_SHORTCUT = "CommandOrControl+Shift+Space";
const HIDE_FALLBACK_TIMEOUT_MS = 420;

export class DesktopIsland extends Context.Service<
  DesktopIsland,
  {
    readonly syncSnapshot: (
      snapshot: IslandSnapshot,
      senderWebContentsId?: number,
    ) => Effect.Effect<void>;
    readonly updateSettings: (settings: IslandSettings) => Effect.Effect<void>;
    readonly openPanel: (options?: { readonly startVoice?: boolean }) => Effect.Effect<void>;
    readonly closePanel: () => Effect.Effect<void>;
  }
>()("@t3tools/desktop/island/DesktopIsland") {}

interface ComputedNotchPlacement {
  readonly bounds: Electron.Rectangle;
  readonly metrics: IslandDisplayMetrics;
}

function computeNotchPlacement(isMac: boolean): ComputedNotchPlacement {
  const display =
    Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()) ??
    Electron.screen.getPrimaryDisplay();
  const { x, y, width } = display.bounds;
  const topInset = Math.max(0, display.workArea.y - display.bounds.y);
  // Notched MacBooks reserve 32-38pt at the top edge vs 24-25pt for standard macOS menu bars.
  const hasNotch = isMac && topInset >= 30;
  const notchHeight = hasNotch ? Math.min(40, Math.max(32, topInset)) : 34;
  const notchWidth = hasNotch ? 188 : 168;
  return {
    bounds: {
      x: Math.round(x + (width - ISLAND_WINDOW_WIDTH) / 2),
      y,
      width: ISLAND_WINDOW_WIDTH,
      height: ISLAND_WINDOW_HEIGHT,
    },
    metrics: {
      hasNotch,
      notchWidth,
      notchHeight,
      windowWidth: ISLAND_WINDOW_WIDTH,
    },
  };
}

export const layer = Layer.effect(
  DesktopIsland,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const isMac = environment.platform === "darwin";

    let islandWindow: Electron.BrowserWindow | null = null;
    let islandReady = false;
    let latestSnapshot: IslandSnapshot | null = null;
    let latestMetrics: IslandDisplayMetrics = {
      hasNotch: isMac,
      notchWidth: 188,
      notchHeight: 37,
      windowWidth: ISLAND_WINDOW_WIDTH,
    };
    let currentSettings: IslandSettings = DEFAULT_ISLAND_SETTINGS;
    let shortcutsInitialized = false;
    let screenListenerAttached = false;
    let forcedOpen = false;
    let pendingHide = false;
    let pendingHideTimer: ReturnType<typeof setTimeout> | null = null;
    let mainWebContentsId: number | null = null;
    let stopModifierMonitor: (() => void) | null = null;
    let registeredGlobalShortcut: string | null = null;

    const clearPendingHide = () => {
      pendingHide = false;
      if (pendingHideTimer !== null) {
        clearTimeout(pendingHideTimer);
        pendingHideTimer = null;
      }
    };

    const completeDeferredHide = () => {
      clearPendingHide();
      if (islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible()) {
        islandWindow.setIgnoreMouseEvents(true, { forward: true });
        islandWindow.hide();
      }
    };

    const scheduleDeferredHide = () => {
      if (!islandWindow || islandWindow.isDestroyed() || !islandWindow.isVisible()) return;
      islandWindow.setIgnoreMouseEvents(true, { forward: true });
      if (pendingHide) return;
      pendingHide = true;
      pendingHideTimer = setTimeout(() => {
        if (pendingHide) {
          completeDeferredHide();
        }
      }, HIDE_FALLBACK_TIMEOUT_MS);
    };

    const findMainWindow = (): Electron.BrowserWindow | null => {
      if (mainWebContentsId !== null) {
        const wc = Electron.webContents.fromId(mainWebContentsId);
        if (wc && !wc.isDestroyed()) {
          const owner = Electron.BrowserWindow.fromWebContents(wc);
          if (owner && !owner.isDestroyed() && owner !== islandWindow) return owner;
        }
      }
      return (
        Electron.BrowserWindow.getAllWindows().find(
          (candidate) => candidate !== islandWindow && !candidate.isDestroyed(),
        ) ?? null
      );
    };

    const sendToMainRenderer = (action: IslandAction) => {
      const mainWindow = findMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(ISLAND_ACTION_CHANNEL, action);
      }
    };

    const revealMainWindow = () => {
      const mainWindow = findMainWindow();
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    };

    const sendCommandToIsland = (command: IslandWindowCommand) => {
      if (islandWindow && !islandWindow.isDestroyed() && islandReady) {
        islandWindow.webContents.send(ISLAND_EXPAND_REQUEST_CHANNEL, command);
      }
    };

    const sendDisplayMetricsToIsland = (metrics: IslandDisplayMetrics) => {
      latestMetrics = metrics;
      if (islandWindow && !islandWindow.isDestroyed() && islandReady) {
        islandWindow.webContents.send(ISLAND_DISPLAY_METRICS_CHANNEL, metrics);
      }
    };

    const repositionIsland = () => {
      const placement = computeNotchPlacement(isMac);
      latestMetrics = placement.metrics;
      if (!islandWindow || islandWindow.isDestroyed()) return;
      islandWindow.setBounds(placement.bounds, false);
      sendDisplayMetricsToIsland(placement.metrics);
    };

    const ensureScreenListener = () => {
      if (screenListenerAttached) return;
      screenListenerAttached = true;
      Electron.screen.on("display-metrics-changed", repositionIsland);
    };

    const ensureIslandWindow = (): Electron.BrowserWindow => {
      ensureScreenListener();
      if (islandWindow && !islandWindow.isDestroyed()) {
        return islandWindow;
      }
      const preloadPath = environment.path.join(environment.dirname, "island-preload.cjs");
      const placement = computeNotchPlacement(isMac);
      latestMetrics = placement.metrics;
      const win = new Electron.BrowserWindow({
        ...placement.bounds,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        backgroundColor: "#00000000",
        ...(isMac ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: preloadPath,
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });

      win.setAlwaysOnTop(true, isMac ? "screen-saver" : "floating");
      if (isMac) {
        win.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      }
      win.setIgnoreMouseEvents(true, { forward: true });

      islandReady = false;
      win.webContents.once("did-finish-load", () => {
        islandReady = true;
        if (!win.isDestroyed()) {
          win.webContents.send(ISLAND_DISPLAY_METRICS_CHANNEL, latestMetrics);
          if (latestSnapshot) {
            win.webContents.send(ISLAND_SNAPSHOT_CHANNEL, latestSnapshot);
          }
        }
      });

      win.on("closed", () => {
        clearPendingHide();
        islandWindow = null;
        islandReady = false;
        forcedOpen = false;
      });

      const html = buildIslandHtml();
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);

      islandWindow = win;
      return win;
    };

    const syncVisibility = () => {
      if (!currentSettings.enabled) {
        clearPendingHide();
        if (islandWindow && !islandWindow.isDestroyed() && islandWindow.isVisible()) {
          islandWindow.setIgnoreMouseEvents(true, { forward: true });
          islandWindow.hide();
        }
        return;
      }
      const placement = computeNotchPlacement(isMac);
      latestMetrics = placement.metrics;
      const keepAlive = shouldKeepIslandWindowAlive(
        latestSnapshot,
        forcedOpen,
        placement.metrics.hasNotch,
      );
      if (keepAlive) {
        clearPendingHide();
        const win = ensureIslandWindow();
        if (!win.isVisible()) {
          repositionIsland();
          if (forcedOpen) {
            win.show();
            win.focus();
          } else {
            win.showInactive();
          }
        }
      } else {
        scheduleDeferredHide();
      }
    };

    const triggerFromGlobalShortcut = () => {
      if (!currentSettings.enabled) return;
      clearPendingHide();
      const win = ensureIslandWindow();
      forcedOpen = true;
      repositionIsland();
      win.setIgnoreMouseEvents(false);
      win.show();
      win.focus();
      const dispatch = () => sendCommandToIsland({ type: "toggle-voice-panel", startVoice: true });
      if (islandReady) {
        dispatch();
      } else {
        win.webContents.once("did-finish-load", dispatch);
      }
    };

    const stopShortcuts = () => {
      if (stopModifierMonitor) {
        stopModifierMonitor();
        stopModifierMonitor = null;
      }
      if (registeredGlobalShortcut) {
        try {
          Electron.globalShortcut.unregister(registeredGlobalShortcut);
        } catch {}
        registeredGlobalShortcut = null;
      }
    };

    const applyShortcuts = (settings: IslandSettings) => {
      shortcutsInitialized = true;
      stopShortcuts();
      if (!settings.enabled || settings.shortcut === "off") return;

      if (isMac && (settings.shortcut === "control" || settings.shortcut === "option")) {
        void startMacSingleTapModifierMonitor(
          settings.shortcut,
          () => triggerFromGlobalShortcut(),
          () => undefined,
        )
          .then((stop) => {
            if (!currentSettings.enabled || currentSettings.shortcut !== settings.shortcut) {
              stop();
              return;
            }
            stopModifierMonitor = stop;
          })
          .catch(() => undefined);
      } else if (settings.shortcut === "command-shift-space") {
        try {
          if (
            Electron.globalShortcut.register(ISLAND_FALLBACK_SHORTCUT, triggerFromGlobalShortcut)
          ) {
            registeredGlobalShortcut = ISLAND_FALLBACK_SHORTCUT;
          }
        } catch {}
      }
    };

    const onIslandAction = (event: Electron.IpcMainEvent, rawAction: unknown) => {
      if (
        !islandWindow ||
        islandWindow.isDestroyed() ||
        event.sender !== islandWindow.webContents
      ) {
        return;
      }
      if (typeof rawAction !== "object" || rawAction === null || !("type" in rawAction)) return;
      const action = rawAction as IslandAction;
      if (action.type === "close-panel") {
        forcedOpen = false;
        syncVisibility();
      }
      if (
        action.type === "open-thread" ||
        action.type === "open-voice-settings" ||
        action.type === "open-island-settings" ||
        action.type === "assistant-open-voice-mode-modal"
      ) {
        forcedOpen = false;
        syncVisibility();
        revealMainWindow();
      }
      sendToMainRenderer(action);
    };

    const onMousePassthrough = (event: Electron.IpcMainEvent, ignore: unknown) => {
      if (
        !islandWindow ||
        islandWindow.isDestroyed() ||
        event.sender !== islandWindow.webContents
      ) {
        return;
      }
      if (ignore === true) {
        islandWindow.setIgnoreMouseEvents(true, { forward: true });
      } else {
        islandWindow.setIgnoreMouseEvents(false);
      }
    };

    const onFocusWindow = (event: Electron.IpcMainEvent) => {
      if (
        !islandWindow ||
        islandWindow.isDestroyed() ||
        event.sender !== islandWindow.webContents
      ) {
        return;
      }
      clearPendingHide();
      forcedOpen = true;
      islandWindow.setIgnoreMouseEvents(false);
      islandWindow.show();
      islandWindow.focus();
    };

    const onAnimationIdle = (event: Electron.IpcMainEvent) => {
      if (
        !islandWindow ||
        islandWindow.isDestroyed() ||
        event.sender !== islandWindow.webContents
      ) {
        return;
      }
      if (pendingHide) {
        completeDeferredHide();
      }
    };

    const onContextMenu = (event: Electron.IpcMainEvent) => {
      if (
        !islandWindow ||
        islandWindow.isDestroyed() ||
        event.sender !== islandWindow.webContents
      ) {
        return;
      }
      const menu = Electron.Menu.buildFromTemplate([
        {
          label: "Open mattr",
          click: () => revealMainWindow(),
        },
        {
          label: "Open Voice Mode",
          click: () => {
            forcedOpen = false;
            syncVisibility();
            revealMainWindow();
            sendToMainRenderer({ type: "assistant-open-voice-mode-modal" });
          },
        },
        {
          label: "Island settings…",
          click: () => {
            forcedOpen = false;
            syncVisibility();
            revealMainWindow();
            sendToMainRenderer({ type: "open-island-settings" });
          },
        },
        { type: "separator" },
        {
          label: "Close Island",
          click: () => {
            forcedOpen = false;
            sendCommandToIsland({ type: "close-panel" });
            syncVisibility();
          },
        },
      ]);
      menu.popup({ window: islandWindow });
    };

    Electron.ipcMain.on(ISLAND_ACTION_CHANNEL, onIslandAction);
    Electron.ipcMain.on(ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL, onMousePassthrough);
    Electron.ipcMain.on(ISLAND_FOCUS_WINDOW_CHANNEL, onFocusWindow);
    Electron.ipcMain.on(ISLAND_CONTEXT_MENU_CHANNEL, onContextMenu);
    Electron.ipcMain.on(ISLAND_ANIMATION_IDLE_CHANNEL, onAnimationIdle);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearPendingHide();
        stopShortcuts();
        Electron.ipcMain.removeListener(ISLAND_ACTION_CHANNEL, onIslandAction);
        Electron.ipcMain.removeListener(ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL, onMousePassthrough);
        Electron.ipcMain.removeListener(ISLAND_FOCUS_WINDOW_CHANNEL, onFocusWindow);
        Electron.ipcMain.removeListener(ISLAND_CONTEXT_MENU_CHANNEL, onContextMenu);
        Electron.ipcMain.removeListener(ISLAND_ANIMATION_IDLE_CHANNEL, onAnimationIdle);
        if (screenListenerAttached) {
          Electron.screen.removeListener("display-metrics-changed", repositionIsland);
        }
        if (islandWindow && !islandWindow.isDestroyed()) {
          islandWindow.destroy();
        }
        islandWindow = null;
      }),
    );

    return DesktopIsland.of({
      syncSnapshot: Effect.fn("desktop.island.syncSnapshot")(
        function* (snapshot, senderWebContentsId) {
          yield* Effect.sync(() => {
            if (senderWebContentsId !== undefined) {
              mainWebContentsId = senderWebContentsId;
            }
            latestSnapshot = snapshot;
            if (
              !shortcutsInitialized ||
              snapshot.settings.enabled !== currentSettings.enabled ||
              snapshot.settings.shortcut !== currentSettings.shortcut
            ) {
              currentSettings = snapshot.settings;
              applyShortcuts(currentSettings);
            } else {
              currentSettings = snapshot.settings;
            }
            if (islandWindow && !islandWindow.isDestroyed() && islandReady) {
              islandWindow.webContents.send(ISLAND_SNAPSHOT_CHANNEL, snapshot);
            }
            syncVisibility();
          });
        },
      ),
      updateSettings: Effect.fn("desktop.island.updateSettings")(function* (settings) {
        yield* Effect.sync(() => {
          currentSettings = settings;
          applyShortcuts(settings);
          syncVisibility();
        });
      }),
      openPanel: Effect.fn("desktop.island.openPanel")(function* (options) {
        yield* Effect.sync(() => {
          if (!currentSettings.enabled) return;
          clearPendingHide();
          const win = ensureIslandWindow();
          forcedOpen = true;
          repositionIsland();
          win.setIgnoreMouseEvents(false);
          win.show();
          win.focus();
          const dispatch = () =>
            sendCommandToIsland({
              type: "open-voice-panel",
              startVoice: options?.startVoice === true,
            });
          if (islandReady) dispatch();
          else win.webContents.once("did-finish-load", dispatch);
        });
      }),
      closePanel: Effect.fn("desktop.island.closePanel")(function* () {
        yield* Effect.sync(() => {
          forcedOpen = false;
          sendCommandToIsland({ type: "close-panel" });
          syncVisibility();
        });
      }),
    });
  }),
);
