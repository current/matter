import type * as Electron from "electron";

type MakeKey = (contentView: bigint) => void;

let makeKeyPromise: Promise<MakeKey | null> | undefined;

function loadMakeKey(): Promise<MakeKey | null> {
  return (makeKeyPromise ??= import("ffi-rs")
    .then(({ DataType, load, open }) => {
      const objc = "matter-objc-island-panel";
      open({ library: objc, path: "/usr/lib/libobjc.A.dylib" });
      const sel = (name: string): bigint =>
        load({
          library: objc,
          funcName: "sel_registerName",
          retType: DataType.BigInt,
          paramsType: [DataType.String],
          paramsValue: [name],
        }).valueOf();
      const windowSel = sel("window");
      const makeKeySel = sel("makeKeyWindow");
      return (contentView: bigint) => {
        const nsWindow = load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.BigInt,
          paramsType: [DataType.BigInt, DataType.BigInt],
          paramsValue: [contentView, windowSel],
        }).valueOf();
        if (nsWindow === 0n) return;
        load({
          library: objc,
          funcName: "objc_msgSend",
          retType: DataType.Void,
          paramsType: [DataType.BigInt, DataType.BigInt],
          paramsValue: [nsWindow, makeKeySel],
        });
      };
    })
    .catch(() => null));
}

/**
 * Gives the island keyboard focus without activating the app. The window is an NSPanel with the
 * non-activating style mask (`type: "panel"`), so `makeKeyWindow` takes key status while the app
 * the user is in stays active and macOS never switches Spaces to Matter's main window.
 * `BrowserWindow.focus()` would activate the app; it is only the fallback.
 */
export async function focusIslandWithoutActivating(
  window: Electron.BrowserWindow,
  isMac: boolean,
): Promise<void> {
  if (window.isDestroyed()) return;
  if (!window.isVisible()) window.showInactive();
  const makeKey = isMac ? await loadMakeKey() : null;
  const handle = window.getNativeWindowHandle();
  if (makeKey && Buffer.isBuffer(handle) && handle.byteLength >= 8 && !window.isDestroyed()) {
    makeKey(handle.readBigUInt64LE(0));
    return;
  }
  if (!window.isDestroyed()) {
    window.show();
    window.focus();
  }
}
