import type { ShellMaterial } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

interface MacObjcBridge {
  readonly objcGetClass: (name: string) => bigint;
  readonly sel: (name: string) => bigint;
  readonly msg0: (obj: bigint, selector: string) => bigint;
  readonly msg1Ptr: (obj: bigint, selector: string, arg: bigint) => bigint;
  readonly msg1Bool: (obj: bigint, selector: string, arg: boolean) => void;
  readonly msg1I64: (obj: bigint, selector: string, arg: number) => void;
  readonly msg1Double: (obj: bigint, selector: string, arg: number) => void;
  readonly msgAddSubview: (
    parent: bigint,
    subview: bigint,
    positioning: number,
    relativeTo: bigint,
  ) => void;
}

interface WindowMaterialState {
  glassView: bigint | null;
  hasVibrancy: boolean;
  hasWindowsMaterial: boolean;
  nonOpaque: boolean;
}

const NS_WINDOW_BELOW = -1;
const NS_GLASS_EFFECT_STYLE_REGULAR = 0;
const MACOS_LIQUID_GLASS_CORNER_RADIUS = 16;

const windowStates = new WeakMap<Electron.BrowserWindow, WindowMaterialState>();
let macObjcBridgePromise: Promise<MacObjcBridge | null> | undefined;

function getWindowState(window: Electron.BrowserWindow): WindowMaterialState {
  let state = windowStates.get(window);
  if (!state) {
    state = {
      glassView: null,
      hasVibrancy: false,
      hasWindowsMaterial: false,
      nonOpaque: false,
    };
    windowStates.set(window, state);
  }
  return state;
}

function loadMacObjcBridge(): Promise<MacObjcBridge | null> {
  return (macObjcBridgePromise ??= import("ffi-rs")
    .then(({ DataType, load, open }) => {
      const objc = "mattr-objc-shell-material";
      const appKit = "mattr-appkit-shell-material";
      open({ library: objc, path: "/usr/lib/libobjc.A.dylib" });
      open({ library: appKit, path: "/System/Library/Frameworks/AppKit.framework/AppKit" });

      const selectors = new Map<string, bigint>();
      const sel = (name: string): bigint => {
        const cached = selectors.get(name);
        if (cached !== undefined) return cached;
        const registered = load({
          library: objc,
          funcName: "sel_registerName",
          retType: DataType.BigInt,
          paramsType: [DataType.String],
          paramsValue: [name],
        }).valueOf();
        selectors.set(name, registered);
        return registered;
      };

      const bridge: MacObjcBridge = {
        objcGetClass: (name) =>
          load({
            library: objc,
            funcName: "objc_getClass",
            retType: DataType.BigInt,
            paramsType: [DataType.String],
            paramsValue: [name],
          }).valueOf(),
        sel,
        msg0: (obj, selector) =>
          load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.BigInt,
            paramsType: [DataType.BigInt, DataType.BigInt],
            paramsValue: [obj, sel(selector)],
          }).valueOf(),
        msg1Ptr: (obj, selector, arg) =>
          load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.BigInt,
            paramsType: [DataType.BigInt, DataType.BigInt, DataType.BigInt],
            paramsValue: [obj, sel(selector), arg],
          }).valueOf(),
        msg1Bool: (obj, selector, arg) => {
          load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.Void,
            paramsType: [DataType.BigInt, DataType.BigInt, DataType.Boolean],
            paramsValue: [obj, sel(selector), arg],
          });
        },
        msg1I64: (obj, selector, arg) => {
          load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.Void,
            paramsType: [DataType.BigInt, DataType.BigInt, DataType.I64],
            paramsValue: [obj, sel(selector), arg],
          });
        },
        msg1Double: (obj, selector, arg) => {
          load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.Void,
            paramsType: [DataType.BigInt, DataType.BigInt, DataType.Double],
            paramsValue: [obj, sel(selector), arg],
          });
        },
        msgAddSubview: (parent, subview, positioning, relativeTo) => {
          load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.Void,
            paramsType: [
              DataType.BigInt,
              DataType.BigInt,
              DataType.BigInt,
              DataType.I64,
              DataType.BigInt,
            ],
            paramsValue: [
              parent,
              sel("addSubview:positioned:relativeTo:"),
              subview,
              positioning,
              relativeTo,
            ],
          });
        },
      };
      return bridge;
    })
    .catch(() => null));
}

function readNativeContentViewPointer(window: Electron.BrowserWindow): bigint | null {
  if (typeof window.getNativeWindowHandle !== "function") return null;
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.byteLength < 8) return null;
  const pointer = handle.readBigUInt64LE(0);
  return pointer === 0n ? null : pointer;
}

function detachMacGlassView(bridge: MacObjcBridge, state: WindowMaterialState): void {
  if (state.glassView === null) return;
  try {
    bridge.msg0(state.glassView, "removeFromSuperview");
    bridge.msg0(state.glassView, "release");
  } catch {
    // Ignore native teardown failures if the window is already disposing.
  }
  state.glassView = null;
}

function setMacWindowOpaque(
  bridge: MacObjcBridge,
  window: Electron.BrowserWindow,
  opaque: boolean,
): void {
  const contentView = readNativeContentViewPointer(window);
  if (contentView === null) return;
  const nsWindow = bridge.msg0(contentView, "window");
  if (nsWindow === 0n) return;
  bridge.msg1Bool(nsWindow, "setOpaque:", opaque);
  if (!opaque) {
    const nsColorClass = bridge.objcGetClass("NSColor");
    if (nsColorClass !== 0n) {
      const clearColor = bridge.msg0(nsColorClass, "clearColor");
      if (clearColor !== 0n) {
        bridge.msg1Ptr(nsWindow, "setBackgroundColor:", clearColor);
      }
    }
  }
  bridge.msg0(nsWindow, "invalidateShadow");
}

function attachMacLiquidGlassView(
  bridge: MacObjcBridge,
  window: Electron.BrowserWindow,
  state: WindowMaterialState,
): boolean {
  const contentView = readNativeContentViewPointer(window);
  if (contentView === null) return false;
  const glassClass = bridge.objcGetClass("NSGlassEffectView");
  if (glassClass === 0n) return false;

  setMacWindowOpaque(bridge, window, false);
  state.nonOpaque = true;

  if (state.glassView === null) {
    const allocated = bridge.msg0(glassClass, "alloc");
    const glassView = allocated === 0n ? 0n : bridge.msg0(allocated, "init");
    if (glassView === 0n) return false;
    bridge.msg1Bool(glassView, "setTranslatesAutoresizingMaskIntoConstraints:", false);
    bridge.msg1I64(glassView, "setStyle:", NS_GLASS_EFFECT_STYLE_REGULAR);
    bridge.msg1Double(glassView, "setCornerRadius:", MACOS_LIQUID_GLASS_CORNER_RADIUS);
    bridge.msgAddSubview(contentView, glassView, NS_WINDOW_BELOW, 0n);
    for (const anchor of ["topAnchor", "bottomAnchor", "leadingAnchor", "trailingAnchor"]) {
      const viewAnchor = bridge.msg0(glassView, anchor);
      const parentAnchor = bridge.msg0(contentView, anchor);
      if (viewAnchor !== 0n && parentAnchor !== 0n) {
        const constraint = bridge.msg1Ptr(viewAnchor, "constraintEqualToAnchor:", parentAnchor);
        if (constraint !== 0n) {
          bridge.msg1Bool(constraint, "setActive:", true);
        }
      }
    }
    state.glassView = glassView;
  }

  return true;
}

function setVibrancySafe(window: Electron.BrowserWindow, vibrancy: "under-window" | null): boolean {
  if (typeof window.setVibrancy !== "function") return false;
  window.setVibrancy(vibrancy);
  return true;
}

function setWindowsMaterialSafe(
  window: Electron.BrowserWindow,
  material: "none" | "acrylic" | "mica",
): boolean {
  if (typeof window.setBackgroundMaterial !== "function") return false;
  window.setBackgroundMaterial(material);
  return true;
}

export function applyWindowShellMaterial(
  window: Electron.BrowserWindow,
  options: {
    readonly material: ShellMaterial;
    readonly solidBackgroundColor: string;
    readonly platform: NodeJS.Platform;
  },
): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (window.isDestroyed()) return;

    const existingState = windowStates.get(window);
    if (
      options.material === "solid" &&
      (existingState === undefined ||
        (existingState.glassView === null &&
          !existingState.hasVibrancy &&
          !existingState.hasWindowsMaterial &&
          !existingState.nonOpaque))
    ) {
      window.setBackgroundColor(options.solidBackgroundColor);
      return;
    }

    const state = getWindowState(window);

    if (options.platform === "darwin") {
      if (options.material === "solid") {
        if (state.glassView !== null || state.nonOpaque) {
          const bridge = await loadMacObjcBridge();
          if (bridge && !window.isDestroyed()) {
            detachMacGlassView(bridge, state);
            if (state.nonOpaque) {
              setMacWindowOpaque(bridge, window, true);
              state.nonOpaque = false;
            }
          }
        }
        if (state.hasVibrancy && !window.isDestroyed()) {
          setVibrancySafe(window, null);
          state.hasVibrancy = false;
        }
        if (!window.isDestroyed()) {
          window.setBackgroundColor(options.solidBackgroundColor);
        }
        return;
      }

      if (options.material === "transparent") {
        const bridge = await loadMacObjcBridge();
        if (window.isDestroyed()) return;
        if (bridge) {
          detachMacGlassView(bridge, state);
        }
        if (state.hasVibrancy) {
          setVibrancySafe(window, null);
          state.hasVibrancy = false;
        }
        window.setBackgroundColor("#00000000");
        if (bridge) {
          setMacWindowOpaque(bridge, window, false);
          state.nonOpaque = true;
        }
        return;
      }

      if (options.material === "blur") {
        if (state.glassView !== null) {
          const bridge = await loadMacObjcBridge();
          if (bridge && !window.isDestroyed()) {
            detachMacGlassView(bridge, state);
          }
        }
        if (window.isDestroyed()) return;
        window.setBackgroundColor("#00000000");
        if (setVibrancySafe(window, "under-window")) {
          state.hasVibrancy = true;
        }
        return;
      }

      // Liquid Glass on macOS 26+, falling back to frosted vibrancy on older macOS.
      if (state.hasVibrancy) {
        setVibrancySafe(window, null);
        state.hasVibrancy = false;
      }
      window.setBackgroundColor("#00000000");
      const bridge = await loadMacObjcBridge();
      if (window.isDestroyed()) return;
      if (bridge && attachMacLiquidGlassView(bridge, window, state)) {
        return;
      }
      if (setVibrancySafe(window, "under-window")) {
        state.hasVibrancy = true;
      }
      return;
    }

    if (options.platform === "win32") {
      if (options.material === "solid") {
        if (state.hasWindowsMaterial) {
          setWindowsMaterialSafe(window, "none");
          state.hasWindowsMaterial = false;
        }
        window.setBackgroundColor(options.solidBackgroundColor);
        return;
      }
      window.setBackgroundColor("#00000000");
      const material = options.material === "liquid-glass" ? "mica" : "acrylic";
      if (setWindowsMaterialSafe(window, material)) {
        state.hasWindowsMaterial = true;
      }
      return;
    }

    window.setBackgroundColor(options.solidBackgroundColor);
  });
}

export function cleanupWindowShellMaterial(window: Electron.BrowserWindow): void {
  const state = windowStates.get(window);
  if (!state) return;
  windowStates.delete(window);
  if (state.glassView === null) return;
  const glassView = state.glassView;
  state.glassView = null;
  void loadMacObjcBridge().then((bridge) => {
    if (!bridge) return;
    try {
      bridge.msg0(glassView, "removeFromSuperview");
      bridge.msg0(glassView, "release");
    } catch {
      // Window is already closed.
    }
  });
}
