import {
  type ClientSettings,
  DEFAULT_CLIENT_SETTINGS,
  type ShellGlassStyle,
  type ShellMaterial,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";

import {
  type ShellGlassTint,
  shellBlurRadius,
  shellGlassTint,
} from "../../../../antimatter/shellTint.ts";

// Native seam (tests swap it). Blur uses SkyLight's CGSSetWindowBackgroundBlurRadius, as iTerm2
// and Ghostty do: NSVisualEffectView materials have a fixed blur no slider can move. Liquid Glass
// is AppKit's NSGlassEffectView (macOS 26+), configured through its public style and tintColor.
export interface MacShellNative {
  readonly setWindowClear: (contentView: bigint) => void;
  readonly createGlassView: (contentView: bigint) => bigint | null;
  readonly setGlassStyle: (glassView: bigint, style: ShellGlassStyle) => void;
  readonly setGlassTint: (glassView: bigint, tint: ShellGlassTint | null) => void;
  readonly removeGlassView: (glassView: bigint) => void;
  /** False when the private blur call is unavailable, so the caller falls back to vibrancy. */
  readonly setBackgroundBlurRadius: (contentView: bigint, radius: number) => boolean;
}

export interface WindowShellMaterialOptions {
  readonly material: ShellMaterial;
  readonly solidBackgroundColor: string;
  readonly platform: NodeJS.Platform;
  /** Native blur radius in points for the Blur material. */
  readonly blurRadius?: number;
  readonly glassStyle?: ShellGlassStyle;
  readonly glassTint?: ShellGlassTint | null;
}

interface WindowMaterialState {
  glassView: bigint | null;
  glassStyle: ShellGlassStyle | null;
  glassTintKey: string | null;
  blurRadius: number;
  hasVibrancy: boolean;
  hasWindowsMaterial: boolean;
  latestOptions: WindowShellMaterialOptions | null;
  reapplyOnShow: boolean;
}

const NS_WINDOW_BELOW = -1;
const NS_GLASS_EFFECT_STYLE: Record<ShellGlassStyle, number> = { regular: 0, clear: 1 };
const DEFAULT_BLUR_RADIUS = 38;

// NSGlassEffectView draws a specular rim along its own rounded edge. Flush with the content view
// at 16pt it sat inside the window's own 10pt corner as a second, mismatched corner. Square and
// past every window edge, only its body shows and the window's rounded clip draws the one corner.
const LIQUID_GLASS_EDGE_OUTSET = 24;
export const LIQUID_GLASS_EDGE_CONSTRAINTS = [
  ["topAnchor", -LIQUID_GLASS_EDGE_OUTSET],
  ["leadingAnchor", -LIQUID_GLASS_EDGE_OUTSET],
  ["bottomAnchor", LIQUID_GLASS_EDGE_OUTSET],
  ["trailingAnchor", LIQUID_GLASS_EDGE_OUTSET],
] as const;

const windowStates = new WeakMap<Electron.BrowserWindow, WindowMaterialState>();
let macNativePromise: Promise<MacShellNative | null> | undefined;

function getWindowState(window: Electron.BrowserWindow): WindowMaterialState {
  let state = windowStates.get(window);
  if (!state) {
    state = {
      glassView: null,
      glassStyle: null,
      glassTintKey: null,
      blurRadius: 0,
      hasVibrancy: false,
      hasWindowsMaterial: false,
      latestOptions: null,
      reapplyOnShow: false,
    };
    windowStates.set(window, state);
  }
  return state;
}

function loadMacShellNative(): Promise<MacShellNative | null> {
  return (macNativePromise ??= import("ffi-rs")
    .then(({ DataType, load, open }) => {
      const objc = "mattr-objc-shell-material";
      open({ library: objc, path: "/usr/lib/libobjc.A.dylib" });
      open({
        library: "mattr-appkit-shell-material",
        path: "/System/Library/Frameworks/AppKit.framework/AppKit",
      });
      const coreFoundation = "mattr-corefoundation-shell-material";
      open({
        library: coreFoundation,
        path: "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
      });
      let skyLight: string | null = "mattr-skylight-shell-material";
      try {
        open({
          library: skyLight,
          path: "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight",
        });
      } catch {
        skyLight = null;
      }

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
      const getClass = (name: string): bigint =>
        load({
          library: objc,
          funcName: "objc_getClass",
          retType: DataType.BigInt,
          paramsType: [DataType.String],
          paramsValue: [name],
        }).valueOf();
      const msg0 = (obj: bigint, selector: string): bigint =>
        load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt, DataType.BigInt],
          paramsValue: [obj, sel(selector)],
        }).valueOf();
      const msgPtr = (obj: bigint, selector: string, arg: bigint): bigint =>
        load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt, DataType.BigInt, DataType.BigInt],
          paramsValue: [obj, sel(selector), arg],
        }).valueOf();
      const msgBool = (obj: bigint, selector: string, arg: boolean): void => {
        load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.Void,
          paramsType: [DataType.BigInt, DataType.BigInt, DataType.Boolean],
          paramsValue: [obj, sel(selector), arg],
        });
      };
      const msgI64 = (obj: bigint, selector: string, arg: number): void => {
        load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.Void,
          paramsType: [DataType.BigInt, DataType.BigInt, DataType.I64],
          paramsValue: [obj, sel(selector), arg],
        });
      };
      const msgDouble = (obj: bigint, selector: string, arg: number): void => {
        load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.Void,
          paramsType: [DataType.BigInt, DataType.BigInt, DataType.Double],
          paramsValue: [obj, sel(selector), arg],
        });
      };
      const nsWindowOf = (contentView: bigint): bigint => msg0(contentView, "window");
      const matchWindowServerCornerRadius = (
        nsWindow: bigint,
        connection: number,
        windowNumber: number,
        match: boolean,
      ): void => {
        if (skyLight === null) return;
        const cornerRadiusSelector = sel("_cornerRadius");
        const responds = load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.Boolean,
          paramsType: [DataType.BigInt, DataType.BigInt, DataType.BigInt],
          paramsValue: [nsWindow, sel("respondsToSelector:"), cornerRadiusSelector],
        });
        if (match && !responds) return;
        const transaction = load({
          library: skyLight,
          funcName: "SLSTransactionCreate",
          retType: DataType.BigInt,
          paramsType: [DataType.I32],
          paramsValue: [connection],
        }).valueOf();
        if (transaction === 0n) return;
        if (match) {
          const cornerRadius = load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.Double,
            paramsType: [DataType.BigInt, DataType.BigInt],
            paramsValue: [nsWindow, cornerRadiusSelector],
          });
          load({
            library: skyLight,
            funcName: "SLSTransactionSetWindowCornerRadius",
            retType: DataType.Void,
            paramsType: [DataType.BigInt, DataType.I32, DataType.Double],
            paramsValue: [transaction, windowNumber, cornerRadius],
          });
        } else {
          load({
            library: skyLight,
            funcName: "SLSTransactionClearWindowCornerRadius",
            retType: DataType.Void,
            paramsType: [DataType.BigInt, DataType.I32],
            paramsValue: [transaction, windowNumber],
          });
        }
        load({
          library: skyLight,
          funcName: "SLSTransactionCommit",
          retType: DataType.Void,
          paramsType: [DataType.BigInt, DataType.I32],
          paramsValue: [transaction, 0],
        });
        load({
          library: coreFoundation,
          funcName: "CFRelease",
          retType: DataType.Void,
          paramsType: [DataType.BigInt],
          paramsValue: [transaction],
        });
      };

      const native: MacShellNative = {
        setWindowClear: (contentView) => {
          const nsWindow = nsWindowOf(contentView);
          if (nsWindow === 0n) return;
          msgBool(nsWindow, "setOpaque:", false);
          const nsColor = getClass("NSColor");
          const clearColor = nsColor === 0n ? 0n : msg0(nsColor, "clearColor");
          if (clearColor !== 0n) msgPtr(nsWindow, "setBackgroundColor:", clearColor);
          msg0(nsWindow, "invalidateShadow");
        },
        createGlassView: (contentView) => {
          const glassClass = getClass("NSGlassEffectView");
          if (glassClass === 0n) return null;
          const allocated = msg0(glassClass, "alloc");
          const glassView = allocated === 0n ? 0n : msg0(allocated, "init");
          if (glassView === 0n) return null;
          msgBool(glassView, "setTranslatesAutoresizingMaskIntoConstraints:", false);
          msgDouble(glassView, "setCornerRadius:", 0);
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
              contentView,
              sel("addSubview:positioned:relativeTo:"),
              glassView,
              NS_WINDOW_BELOW,
              0n,
            ],
          });
          for (const [anchor, constant] of LIQUID_GLASS_EDGE_CONSTRAINTS) {
            const viewAnchor = msg0(glassView, anchor);
            const parentAnchor = msg0(contentView, anchor);
            if (viewAnchor === 0n || parentAnchor === 0n) continue;
            const constraint = load({
              library: objc,
              funcName: "objc_msgSend",
              retType: DataType.BigInt,
              paramsType: [DataType.BigInt, DataType.BigInt, DataType.BigInt, DataType.Double],
              paramsValue: [
                viewAnchor,
                sel("constraintEqualToAnchor:constant:"),
                parentAnchor,
                constant,
              ],
            }).valueOf();
            if (constraint !== 0n) msgBool(constraint, "setActive:", true);
          }
          return glassView;
        },
        setGlassStyle: (glassView, style) => {
          msgI64(glassView, "setStyle:", NS_GLASS_EFFECT_STYLE[style]);
        },
        setGlassTint: (glassView, tint) => {
          if (tint === null) {
            msgPtr(glassView, "setTintColor:", 0n);
            return;
          }
          const nsColor = getClass("NSColor");
          if (nsColor === 0n) return;
          const color = load({
            library: objc,
            funcName: "objc_msgSend",
            retType: DataType.BigInt,
            paramsType: [
              DataType.BigInt,
              DataType.BigInt,
              DataType.Double,
              DataType.Double,
              DataType.Double,
              DataType.Double,
            ],
            paramsValue: [
              nsColor,
              sel("colorWithSRGBRed:green:blue:alpha:"),
              tint.red,
              tint.green,
              tint.blue,
              tint.alpha,
            ],
          }).valueOf();
          if (color !== 0n) msgPtr(glassView, "setTintColor:", color);
        },
        removeGlassView: (glassView) => {
          msg0(glassView, "removeFromSuperview");
          msg0(glassView, "release");
        },
        setBackgroundBlurRadius: (contentView, radius) => {
          if (skyLight === null) return false;
          const nsWindow = nsWindowOf(contentView);
          if (nsWindow === 0n) return false;
          // A deferred NSWindow has no WindowServer number until it is first shown.
          const windowNumber = Number(msg0(nsWindow, "windowNumber"));
          if (windowNumber <= 0) return false;
          const connection = load({
            library: skyLight,
            funcName: "CGSMainConnectionID",
            retType: DataType.I32,
            paramsType: [],
            paramsValue: [],
          });
          const error = load({
            library: skyLight,
            funcName: "CGSSetWindowBackgroundBlurRadius",
            retType: DataType.I32,
            paramsType: [DataType.I32, DataType.I64, DataType.I32],
            paramsValue: [connection, windowNumber, Math.round(radius)],
          });
          if (error !== 0) return false;
          // The blur fills the WindowServer's own corner (~4pt unless set) while the content keeps
          // the window's 10pt corner, so the backdrop leaked between them as a second corner.
          tryNative(() => {
            matchWindowServerCornerRadius(nsWindow, connection, windowNumber, radius > 0);
            return true;
          });
          return true;
        },
      };
      return native;
    })
    .catch(() => null));
}

/** Swaps the native bridge; tests pass a recorder, `undefined` restores the real one. */
export function setMacShellNativeForTests(native: MacShellNative | null | undefined): void {
  macNativePromise = native === undefined ? undefined : Promise.resolve(native);
}

function readNativeContentViewPointer(window: Electron.BrowserWindow): bigint | null {
  if (typeof window.getNativeWindowHandle !== "function") return null;
  const handle = window.getNativeWindowHandle();
  if (!Buffer.isBuffer(handle) || handle.byteLength < 8) return null;
  const pointer = handle.readBigUInt64LE(0);
  return pointer === 0n ? null : pointer;
}

function glassTintKey(tint: ShellGlassTint | null): string {
  return tint === null ? "none" : `${tint.red},${tint.green},${tint.blue},${tint.alpha}`;
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

function tryNative(call: () => boolean): boolean {
  try {
    return call();
  } catch {
    return false;
  }
}

function isNativeIdle(state: WindowMaterialState | undefined): boolean {
  return (
    state === undefined ||
    (state.glassView === null &&
      state.blurRadius === 0 &&
      !state.hasVibrancy &&
      !state.hasWindowsMaterial)
  );
}

async function applyMacMaterial(
  window: Electron.BrowserWindow,
  state: WindowMaterialState,
  options: WindowShellMaterialOptions,
): Promise<void> {
  const { material } = options;
  const contentView = readNativeContentViewPointer(window);
  const native = contentView === null ? null : await loadMacShellNative();
  if (window.isDestroyed()) return;

  // Tear down whatever the new material doesn't use.
  if (material !== "liquid-glass" && state.glassView !== null) {
    if (native) {
      try {
        native.removeGlassView(state.glassView);
      } catch {
        // The window may already be disposing.
      }
    }
    state.glassView = null;
    state.glassStyle = null;
    state.glassTintKey = null;
  }
  if (material !== "blur" && state.blurRadius !== 0) {
    if (native && contentView !== null) {
      tryNative(() => native.setBackgroundBlurRadius(contentView, 0));
    }
    state.blurRadius = 0;
  }

  // The macOS BrowserWindow is always transparent: CSS paints the frame (solid or translucent)
  // and the inset card, so the window backing stays clear for every material.
  window.setBackgroundColor("#00000000");

  if (material === "blur") {
    const radius = options.blurRadius ?? DEFAULT_BLUR_RADIUS;
    if (
      native &&
      contentView !== null &&
      tryNative(() => native.setBackgroundBlurRadius(contentView, radius))
    ) {
      state.blurRadius = radius;
      if (state.hasVibrancy) {
        setVibrancySafe(window, null);
        state.hasVibrancy = false;
      }
      return;
    }
  }

  if (material === "liquid-glass" && native && contentView !== null) {
    const configured = tryNative(() => {
      if (state.glassView === null) {
        native.setWindowClear(contentView);
        state.glassView = native.createGlassView(contentView);
      }
      if (state.glassView === null) return false;
      const style = options.glassStyle ?? "regular";
      if (state.glassStyle !== style) {
        native.setGlassStyle(state.glassView, style);
        state.glassStyle = style;
      }
      const tint = options.glassTint ?? null;
      const tintKey = glassTintKey(tint);
      if (state.glassTintKey !== tintKey) {
        native.setGlassTint(state.glassView, tint);
        state.glassTintKey = tintKey;
      }
      return true;
    });
    if (configured) {
      if (state.hasVibrancy) {
        setVibrancySafe(window, null);
        state.hasVibrancy = false;
      }
      return;
    }
  }

  // Blur without the WindowServer call, or Liquid Glass before macOS 26: frosted vibrancy.
  const wantsVibrancy = material === "blur" || material === "liquid-glass";
  if (wantsVibrancy && !state.hasVibrancy) {
    state.hasVibrancy = setVibrancySafe(window, "under-window");
  } else if (!wantsVibrancy && state.hasVibrancy) {
    setVibrancySafe(window, null);
    state.hasVibrancy = false;
  }
}

// The main window is created hidden, before the WindowServer knows it, so the blur call fails and
// Blur falls back to vibrancy; apply once more on first show with whatever was last requested.
function scheduleReapplyOnShow(window: Electron.BrowserWindow, state: WindowMaterialState): void {
  if (state.reapplyOnShow || state.latestOptions?.material !== "blur") return;
  if (typeof window.isVisible !== "function" || typeof window.once !== "function") return;
  if (window.isVisible()) return;
  state.reapplyOnShow = true;
  window.once("show", () => {
    state.reapplyOnShow = false;
    const latest = state.latestOptions;
    if (latest === null || window.isDestroyed() || windowStates.get(window) !== state) return;
    void applyMacMaterial(window, state, latest).catch(() => undefined);
  });
}

export function applyWindowShellMaterial(
  window: Electron.BrowserWindow,
  options: WindowShellMaterialOptions,
): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (window.isDestroyed()) return;

    if (options.material === "solid" && isNativeIdle(windowStates.get(window))) {
      window.setBackgroundColor(
        options.platform === "darwin" ? "#00000000" : options.solidBackgroundColor,
      );
      return;
    }

    const state = getWindowState(window);

    if (options.platform === "darwin") {
      state.latestOptions = options;
      await applyMacMaterial(window, state, options);
      scheduleReapplyOnShow(window, state);
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
  void loadMacShellNative().then((native) => {
    if (!native) return;
    try {
      native.removeGlassView(glassView);
    } catch {
      // Window is already closed.
    }
  });
}

export type ShellAppearanceSettings = Pick<
  ClientSettings,
  "shellMaterial" | "shellTransparency" | "shellBlur" | "shellGlassStyle" | "shellColor"
>;

export const DEFAULT_SHELL_APPEARANCE: ShellAppearanceSettings = {
  shellMaterial: DEFAULT_CLIENT_SETTINGS.shellMaterial,
  shellTransparency: DEFAULT_CLIENT_SETTINGS.shellTransparency,
  shellBlur: DEFAULT_CLIENT_SETTINGS.shellBlur,
  shellGlassStyle: DEFAULT_CLIENT_SETTINGS.shellGlassStyle,
  shellColor: DEFAULT_CLIENT_SETTINGS.shellColor,
};

export function pickShellAppearance(settings: ShellAppearanceSettings): ShellAppearanceSettings {
  return {
    shellMaterial: settings.shellMaterial,
    shellTransparency: settings.shellTransparency,
    shellBlur: settings.shellBlur,
    shellGlassStyle: settings.shellGlassStyle,
    shellColor: settings.shellColor,
  };
}

/** The native half of the shell appearance; the renderer paints the CSS half from the same settings. */
export function shellMaterialOptions(
  shell: ShellAppearanceSettings,
  shouldUseDarkColors: boolean,
): Pick<WindowShellMaterialOptions, "material" | "blurRadius" | "glassStyle" | "glassTint"> {
  return {
    material: shell.shellMaterial,
    blurRadius: shellBlurRadius(shell.shellBlur),
    glassStyle: shell.shellGlassStyle,
    glassTint: shellGlassTint(
      shell.shellColor,
      shouldUseDarkColors ? "dark" : "light",
      shell.shellTransparency,
    ),
  };
}
