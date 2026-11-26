// @effect-diagnostics globalDate:off globalTimers:off -- Electron IPC and modifier handlers (hide fallback, hold delay, drag watch, double-tap timing) run outside Effect fibers.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  MODIFIER_TAP_MAX_SECONDS,
  isMacDragEvent,
  startMacSingleTapModifierMonitor,
  type MacModifierEvent,
  type MacMonitorEvent,
} from "../../../../antimatter/island/MacControlTapMonitor.ts";
import { buildIslandHtml } from "../../../../antimatter/island/islandHtml.ts";
import {
  islandModel,
  type IslandModifierGestureState,
} from "../../../../antimatter/island/islandModel.ts";
import {
  ISLAND_DROP_CATCH_HEIGHT,
  ISLAND_WINDOW_WIDTH,
  NOTCHED_DISPLAY_NOTCH_WIDTH,
  computeIslandPlacement,
  type ComputedIslandPlacement,
} from "../../../../antimatter/island/islandPlacement.ts";
import { shouldKeepIslandWindowAlive } from "../../../../antimatter/island/islandVisibility.ts";
import {
  DEFAULT_ISLAND_SETTINGS,
  ISLAND_ACTION_CHANNEL,
  ISLAND_ANIMATION_IDLE_CHANNEL,
  ISLAND_CONTEXT_MENU_CHANNEL,
  ISLAND_DISPLAY_METRICS_CHANNEL,
  ISLAND_EXPAND_REQUEST_CHANNEL,
  ISLAND_FOCUS_WINDOW_CHANNEL,
  ISLAND_RELEASE_FOCUS_CHANNEL,
  ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL,
  ISLAND_SNAPSHOT_CHANNEL,
  type ComposerDictationHoldPhase,
  type IslandAction,
  type IslandDisplayMetrics,
  type IslandSettings,
  type IslandSnapshot,
  type IslandWindowCommand,
} from "../../../../antimatter/island/types.ts";
import { focusIslandWithoutActivating } from "./IslandMacPanel.ts";

const ISLAND_FALLBACK_SHORTCUT = "CommandOrControl+Shift+Space";
const HIDE_FALLBACK_TIMEOUT_MS = 420;
const DRAG_WATCH_INTERVAL_MS = 60;
// A hold for island dictation starts once it can no longer be the first half of a double tap.
const ISLAND_HOLD_START_DELAY_MS = Math.round(MODIFIER_TAP_MAX_SECONDS * 1000);

export function buildIslandWindowOptions(
  bounds: ComputedIslandPlacement["bounds"],
  preloadPath: string,
  isMac: boolean,
): Electron.BrowserWindowConstructorOptions {
  return {
    ...bounds,
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
    // Peek's Approve / Deny answer on the first click without the island taking focus.
    acceptFirstMouse: true,
    // Required on macOS so AppKit does not clamp y down to display.workArea.y on showInactive()/show().
    enableLargerThanScreen: true,
    backgroundColor: "#00000000",
    ...(isMac
      ? {
          // NSPanel with the non-activating style mask: keying it never activates Matter.
          type: "panel" as const,
          roundedCorners: false,
          hiddenInMissionControl: true,
        }
      : {}),
    webPreferences: {
      preload: preloadPath,
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  };
}

export type ModifierTarget = "main" | "island" | "none";

export type ResolvedModifierEvent =
  | { readonly kind: "toggle" }
  | {
      readonly kind: "hold";
      readonly target: "main" | "island";
      readonly phase: ComposerDictationHoldPhase;
    };

export interface ModifierRoutingState {
  readonly gesture: IslandModifierGestureState;
  /** Where the current hold dictates; fixed at hold start so focus changes mid-hold don't move it. */
  readonly holdTarget: "main" | "island" | null;
}

export const INITIAL_MODIFIER_ROUTING: ModifierRoutingState = {
  gesture: { lastTapAt: null },
  holdTarget: null,
};

/**
 * Taps: a double tap opens or closes the island. Holds dictate into whatever composer was focused
 * when the hold started: the main window's, or the open island's. A hold elsewhere is ignored
 * through its release.
 */
export function routeModifierEvent(
  state: ModifierRoutingState,
  event: MacModifierEvent,
  focused: ModifierTarget,
  nowMs: number,
): { readonly state: ModifierRoutingState; readonly events: ReadonlyArray<ResolvedModifierEvent> } {
  const gesture = islandModel.stepModifierGesture(state.gesture, event, nowMs);
  const events: ResolvedModifierEvent[] = [];
  let holdTarget = state.holdTarget;
  switch (event) {
    case "hold-start":
      holdTarget = focused === "none" ? null : focused;
      if (holdTarget) events.push({ kind: "hold", target: holdTarget, phase: "start" });
      break;
    case "hold-end":
    case "hold-cancel":
      if (holdTarget) {
        events.push({
          kind: "hold",
          target: holdTarget,
          phase: event === "hold-end" ? "end" : "cancel",
        });
      }
      holdTarget = null;
      break;
    case "tap":
      if (gesture.toggle) events.push({ kind: "toggle" });
      break;
  }
  return { state: { gesture: gesture.state, holdTarget }, events };
}

/** Whether a cursor (screen points) is close enough to the island's top-center to show drop zones. */
export function isNearDropCatch(
  cursor: { readonly x: number; readonly y: number },
  windowBounds: { readonly x: number; readonly y: number; readonly width: number },
): boolean {
  return (
    cursor.x >= windowBounds.x &&
    cursor.x <= windowBounds.x + windowBounds.width &&
    cursor.y >= windowBounds.y &&
    cursor.y <= windowBounds.y + ISLAND_DROP_CATCH_HEIGHT
  );
}

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

function computeNotchPlacement(isMac: boolean): ComputedIslandPlacement {
  const display =
    Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint()) ??
    Electron.screen.getPrimaryDisplay();
  return computeIslandPlacement(display, isMac);
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
      notchWidth: NOTCHED_DISPLAY_NOTCH_WIDTH,
      notchHeight: 32,
      windowWidth: ISLAND_WINDOW_WIDTH,
    };
    let currentSettings: IslandSettings = DEFAULT_ISLAND_SETTINGS;
    let shortcutsInitialized = false;
    let screenListenerAttached = false;
    let forcedOpen = false;
    let pendingHide = false;
    let pendingHideTimer: ReturnType<typeof setTimeout> | null = null;
    let mainWebContentsId: number | null = null;
    let stopMonitor: (() => void) | null = null;
    let registeredGlobalShortcut: string | null = null;
    let modifierRouting = INITIAL_MODIFIER_ROUTING;
    let islandHoldTimer: ReturnType<typeof setTimeout> | null = null;
    let islandHoldStarted = false;
    let dragWatch: ReturnType<typeof setInterval> | null = null;
    let dragNear = false;

    const usable = (win: Electron.BrowserWindow | null): win is Electron.BrowserWindow =>
      win !== null && !win.isDestroyed();

    const clearPendingHide = () => {
      pendingHide = false;
      if (pendingHideTimer !== null) {
        clearTimeout(pendingHideTimer);
        pendingHideTimer = null;
      }
    };

    const completeDeferredHide = () => {
      clearPendingHide();
      if (usable(islandWindow) && islandWindow.isVisible()) {
        islandWindow.setIgnoreMouseEvents(true, { forward: true });
        islandWindow.hide();
      }
    };

    const scheduleDeferredHide = () => {
      if (!usable(islandWindow) || !islandWindow.isVisible()) return;
      islandWindow.setIgnoreMouseEvents(true, { forward: true });
      if (pendingHide) return;
      pendingHide = true;
      pendingHideTimer = setTimeout(() => {
        if (pendingHide) completeDeferredHide();
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
      if (usable(mainWindow)) mainWindow.webContents.send(ISLAND_ACTION_CHANNEL, action);
    };

    const revealMainWindow = () => {
      const mainWindow = findMainWindow();
      if (!usable(mainWindow)) return;
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    };

    const sendCommandToIsland = (command: IslandWindowCommand) => {
      if (usable(islandWindow) && islandReady) {
        islandWindow.webContents.send(ISLAND_EXPAND_REQUEST_CHANNEL, command);
      }
    };

    const repositionIsland = () => {
      const placement = computeNotchPlacement(isMac);
      latestMetrics = placement.metrics;
      if (!usable(islandWindow)) return;
      islandWindow.setBounds(placement.bounds, false);
      if (islandReady) {
        islandWindow.webContents.send(ISLAND_DISPLAY_METRICS_CHANNEL, placement.metrics);
      }
    };

    const ensureScreenListener = () => {
      if (screenListenerAttached) return;
      screenListenerAttached = true;
      Electron.screen.on("display-metrics-changed", repositionIsland);
      Electron.screen.on("display-added", repositionIsland);
      Electron.screen.on("display-removed", repositionIsland);
    };

    const ensureIslandWindow = (): Electron.BrowserWindow => {
      ensureScreenListener();
      if (usable(islandWindow)) return islandWindow;
      const preloadPath = environment.path.join(environment.dirname, "island-preload.cjs");
      const placement = computeNotchPlacement(isMac);
      latestMetrics = placement.metrics;
      const win = new Electron.BrowserWindow(
        buildIslandWindowOptions(placement.bounds, preloadPath, isMac),
      );

      if (isMac) {
        win.setAlwaysOnTop(true, "screen-saver", 1);
        win.setVisibleOnAllWorkspaces(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
      } else {
        win.setAlwaysOnTop(true, "floating");
      }
      win.setBounds(placement.bounds, false);
      win.setIgnoreMouseEvents(true, { forward: true });
      // A file dropped outside the drop zones must never navigate the island away.
      win.webContents.on("will-navigate", (event) => event.preventDefault());
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      islandReady = false;
      win.webContents.once("did-finish-load", () => {
        islandReady = true;
        if (!win.isDestroyed()) {
          win.webContents.send(ISLAND_DISPLAY_METRICS_CHANNEL, latestMetrics);
          if (latestSnapshot) win.webContents.send(ISLAND_SNAPSHOT_CHANNEL, latestSnapshot);
        }
      });

      win.on("closed", () => {
        clearPendingHide();
        islandWindow = null;
        islandReady = false;
        forcedOpen = false;
      });

      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildIslandHtml())}`);
      islandWindow = win;
      return win;
    };

    const syncVisibility = () => {
      if (!currentSettings.enabled) {
        clearPendingHide();
        if (usable(islandWindow) && islandWindow.isVisible()) {
          islandWindow.setIgnoreMouseEvents(true, { forward: true });
          islandWindow.hide();
        }
        return;
      }
      const placement = computeNotchPlacement(isMac);
      latestMetrics = placement.metrics;
      const keepAlive = shouldKeepIslandWindowAlive(
        latestSnapshot,
        forcedOpen || dragNear,
        placement.metrics.hasNotch,
        Date.now(),
      );
      if (keepAlive) {
        clearPendingHide();
        const win = ensureIslandWindow();
        if (!win.isVisible()) {
          repositionIsland();
          win.showInactive();
          // Re-apply bounds after show so macOS never clamps y down to workArea.y.
          repositionIsland();
        }
      } else {
        scheduleDeferredHide();
      }
    };

    const focusIsland = () => {
      if (!usable(islandWindow)) return;
      clearPendingHide();
      forcedOpen = true;
      islandWindow.setIgnoreMouseEvents(false);
      void focusIslandWithoutActivating(islandWindow, isMac).then(() => repositionIsland());
    };

    /** Hands keyboard focus back to whatever app had it, without hiding the island for long. */
    const releaseIslandFocus = () => {
      forcedOpen = false;
      if (!usable(islandWindow)) return;
      islandWindow.setIgnoreMouseEvents(true, { forward: true });
      if (islandWindow.isFocused()) {
        islandWindow.hide();
        islandWindow.showInactive();
        repositionIsland();
      }
      syncVisibility();
    };

    const openIsland = (reason: "shortcut" | "settings") => {
      if (!currentSettings.enabled) return;
      clearPendingHide();
      const win = ensureIslandWindow();
      forcedOpen = true;
      repositionIsland();
      win.setIgnoreMouseEvents(false);
      const dispatch = () => {
        sendCommandToIsland({ type: "open", reason });
        void focusIslandWithoutActivating(win, isMac).then(() => repositionIsland());
      };
      if (islandReady) dispatch();
      else win.webContents.once("did-finish-load", dispatch);
    };

    const toggleIsland = () => {
      if (usable(islandWindow) && islandWindow.isFocused() && forcedOpen) {
        sendCommandToIsland({ type: "close-panel" });
        releaseIslandFocus();
        return;
      }
      openIsland("shortcut");
    };

    const clearIslandHold = () => {
      if (islandHoldTimer !== null) {
        clearTimeout(islandHoldTimer);
        islandHoldTimer = null;
      }
    };

    const deliverHold = (target: "main" | "island", phase: ComposerDictationHoldPhase) => {
      if (target === "main") {
        sendToMainRenderer({ type: "composer-dictation-hold", phase });
        return;
      }
      if (phase === "start") {
        clearIslandHold();
        islandHoldStarted = false;
        islandHoldTimer = setTimeout(() => {
          islandHoldTimer = null;
          islandHoldStarted = true;
          sendCommandToIsland({ type: "dictation-hold", phase: "start" });
        }, ISLAND_HOLD_START_DELAY_MS);
        return;
      }
      clearIslandHold();
      if (islandHoldStarted) sendCommandToIsland({ type: "dictation-hold", phase });
      islandHoldStarted = false;
    };

    const focusedModifierTarget = () => {
      const focusedWindow = Electron.BrowserWindow.getFocusedWindow();
      if (focusedWindow === null) return "none" as const;
      if (focusedWindow === islandWindow)
        return forcedOpen ? ("island" as const) : ("none" as const);
      return focusedWindow === findMainWindow() ? ("main" as const) : ("none" as const);
    };

    const stopDragWatch = () => {
      if (dragWatch !== null) {
        clearInterval(dragWatch);
        dragWatch = null;
      }
    };

    const onDragEvent = (event: "drag-start" | "drag-end") => {
      if (!currentSettings.enabled) return;
      if (event === "drag-end") {
        stopDragWatch();
        const wasNear = dragNear;
        dragNear = false;
        if (wasNear) {
          sendCommandToIsland({ type: "drag", phase: "end" });
          if (usable(islandWindow) && !forcedOpen) {
            islandWindow.setIgnoreMouseEvents(true, { forward: true });
          }
          syncVisibility();
        }
        return;
      }
      stopDragWatch();
      // Polls only while a drag is in flight; the island window becomes a drop target near the notch.
      dragWatch = setInterval(() => {
        const near = isNearDropCatch(
          Electron.screen.getCursorScreenPoint(),
          computeNotchPlacement(isMac).bounds,
        );
        if (near === dragNear) return;
        dragNear = near;
        if (near) {
          syncVisibility();
          if (usable(islandWindow)) islandWindow.setIgnoreMouseEvents(false);
          sendCommandToIsland({ type: "drag", phase: "near" });
        } else {
          if (usable(islandWindow) && !forcedOpen) {
            islandWindow.setIgnoreMouseEvents(true, { forward: true });
          }
          sendCommandToIsland({ type: "drag", phase: "away" });
          syncVisibility();
        }
      }, DRAG_WATCH_INTERVAL_MS);
    };

    const onMonitorEvent = (event: MacMonitorEvent) => {
      if (isMacDragEvent(event)) {
        onDragEvent(event);
        return;
      }
      const routed = routeModifierEvent(
        modifierRouting,
        event,
        focusedModifierTarget(),
        Date.now(),
      );
      modifierRouting = routed.state;
      for (const resolved of routed.events) {
        if (resolved.kind === "toggle") toggleIsland();
        else deliverHold(resolved.target, resolved.phase);
      }
    };

    const stopShortcuts = () => {
      if (modifierRouting.holdTarget) onMonitorEvent("hold-cancel");
      modifierRouting = INITIAL_MODIFIER_ROUTING;
      stopDragWatch();
      if (stopMonitor) {
        stopMonitor();
        stopMonitor = null;
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
      if (!settings.enabled) return;

      if (isMac) {
        // The poller also watches drags, so it runs whatever the shortcut is.
        const modifier =
          settings.shortcut === "control" || settings.shortcut === "option"
            ? settings.shortcut
            : null;
        void startMacSingleTapModifierMonitor(modifier, onMonitorEvent, () => undefined)
          .then((stop) => {
            if (!currentSettings.enabled || currentSettings.shortcut !== settings.shortcut) {
              stop();
              return;
            }
            stopMonitor = stop;
          })
          .catch(() => undefined);
      }
      if (settings.shortcut === "command-shift-space") {
        try {
          if (Electron.globalShortcut.register(ISLAND_FALLBACK_SHORTCUT, toggleIsland)) {
            registeredGlobalShortcut = ISLAND_FALLBACK_SHORTCUT;
          }
        } catch {}
      }
    };

    const fromIsland = (event: Electron.IpcMainEvent): Electron.BrowserWindow | null =>
      usable(islandWindow) && event.sender === islandWindow.webContents ? islandWindow : null;

    const onIslandAction = (event: Electron.IpcMainEvent, rawAction: unknown) => {
      if (!fromIsland(event)) return;
      if (typeof rawAction !== "object" || rawAction === null || !("type" in rawAction)) return;
      const action = rawAction as IslandAction;
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
      const win = fromIsland(event);
      if (!win) return;
      // A drag near the notch keeps the window a drop target whatever the hit test says.
      if (ignore === true && !dragNear) win.setIgnoreMouseEvents(true, { forward: true });
      else win.setIgnoreMouseEvents(false);
    };

    const onFocusWindow = (event: Electron.IpcMainEvent) => {
      if (fromIsland(event)) focusIsland();
    };

    const onReleaseFocus = (event: Electron.IpcMainEvent) => {
      if (fromIsland(event)) releaseIslandFocus();
    };

    const onAnimationIdle = (event: Electron.IpcMainEvent) => {
      if (!fromIsland(event)) return;
      if (pendingHide) {
        completeDeferredHide();
        return;
      }
      // A ✓ that expired without a new snapshot: check again whether the window should stay.
      syncVisibility();
    };

    const onContextMenu = (event: Electron.IpcMainEvent) => {
      const win = fromIsland(event);
      if (!win) return;
      const toMain = (action: IslandAction) => () => {
        forcedOpen = false;
        syncVisibility();
        revealMainWindow();
        sendToMainRenderer(action);
      };
      Electron.Menu.buildFromTemplate([
        { label: "Open Matter", click: () => revealMainWindow() },
        { label: "Open Voice Mode", click: toMain({ type: "assistant-open-voice-mode-modal" }) },
        { label: "Island settings…", click: toMain({ type: "open-island-settings" }) },
        { type: "separator" },
        {
          label: "Close Island",
          click: () => {
            sendCommandToIsland({ type: "close-panel" });
            releaseIslandFocus();
          },
        },
      ]).popup({ window: win });
    };

    Electron.ipcMain.on(ISLAND_ACTION_CHANNEL, onIslandAction);
    Electron.ipcMain.on(ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL, onMousePassthrough);
    Electron.ipcMain.on(ISLAND_FOCUS_WINDOW_CHANNEL, onFocusWindow);
    Electron.ipcMain.on(ISLAND_RELEASE_FOCUS_CHANNEL, onReleaseFocus);
    Electron.ipcMain.on(ISLAND_CONTEXT_MENU_CHANNEL, onContextMenu);
    Electron.ipcMain.on(ISLAND_ANIMATION_IDLE_CHANNEL, onAnimationIdle);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        clearPendingHide();
        clearIslandHold();
        stopShortcuts();
        Electron.ipcMain.removeListener(ISLAND_ACTION_CHANNEL, onIslandAction);
        Electron.ipcMain.removeListener(ISLAND_SET_MOUSE_PASSTHROUGH_CHANNEL, onMousePassthrough);
        Electron.ipcMain.removeListener(ISLAND_FOCUS_WINDOW_CHANNEL, onFocusWindow);
        Electron.ipcMain.removeListener(ISLAND_RELEASE_FOCUS_CHANNEL, onReleaseFocus);
        Electron.ipcMain.removeListener(ISLAND_CONTEXT_MENU_CHANNEL, onContextMenu);
        Electron.ipcMain.removeListener(ISLAND_ANIMATION_IDLE_CHANNEL, onAnimationIdle);
        if (screenListenerAttached) {
          Electron.screen.removeListener("display-metrics-changed", repositionIsland);
          Electron.screen.removeListener("display-added", repositionIsland);
          Electron.screen.removeListener("display-removed", repositionIsland);
        }
        if (usable(islandWindow)) islandWindow.destroy();
        islandWindow = null;
      }),
    );

    return DesktopIsland.of({
      syncSnapshot: Effect.fn("desktop.island.syncSnapshot")(
        function* (snapshot, senderWebContentsId) {
          yield* Effect.sync(() => {
            if (senderWebContentsId !== undefined) mainWebContentsId = senderWebContentsId;
            latestSnapshot = snapshot;
            const shortcutsChanged =
              !shortcutsInitialized ||
              snapshot.settings.enabled !== currentSettings.enabled ||
              snapshot.settings.shortcut !== currentSettings.shortcut;
            currentSettings = snapshot.settings;
            if (shortcutsChanged) applyShortcuts(currentSettings);
            if (usable(islandWindow) && islandReady) {
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
      openPanel: Effect.fn("desktop.island.openPanel")(function* () {
        yield* Effect.sync(() => openIsland("settings"));
      }),
      closePanel: Effect.fn("desktop.island.closePanel")(function* () {
        yield* Effect.sync(() => {
          sendCommandToIsland({ type: "close-panel" });
          releaseIslandFocus();
        });
      }),
    });
  }),
);
