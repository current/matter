import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { afterEach, vi } from "vite-plus/test";

import {
  applyWindowShellMaterial,
  cleanupWindowShellMaterial,
  DEFAULT_SHELL_APPEARANCE,
  LIQUID_GLASS_EDGE_CONSTRAINTS,
  type MacShellNative,
  setMacShellNativeForTests,
  shellMaterialOptions,
} from "./MattrShellMaterial.ts";

const CONTENT_VIEW = 0x1234n;
const GLASS_VIEW = 0x5678n;

function makeFakeWindow(options: { readonly native?: boolean } = {}) {
  const handle = Buffer.alloc(8);
  handle.writeBigUInt64LE(CONTENT_VIEW);
  return {
    isDestroyed: vi.fn(() => false),
    setBackgroundColor: vi.fn(),
    setVibrancy: vi.fn(),
    setBackgroundMaterial: vi.fn(),
    ...(options.native ? { getNativeWindowHandle: () => handle } : {}),
  } as unknown as Electron.BrowserWindow;
}

function makeFakeNative(
  options: { readonly blurAvailable?: boolean; readonly glass?: boolean } = {},
) {
  const calls: Array<readonly unknown[]> = [];
  const native: MacShellNative = {
    setWindowClear: (view) => void calls.push(["setWindowClear", view]),
    createGlassView: (view) => {
      calls.push(["createGlassView", view]);
      return options.glass === false ? null : GLASS_VIEW;
    },
    setGlassStyle: (view, style) => void calls.push(["setGlassStyle", view, style]),
    setGlassTint: (view, tint) => void calls.push(["setGlassTint", view, tint]),
    removeGlassView: (view) => void calls.push(["removeGlassView", view]),
    setBackgroundBlurRadius: (view, radius) => {
      calls.push(["setBackgroundBlurRadius", view, radius]);
      return options.blurAvailable !== false;
    },
  };
  return { native, calls };
}

afterEach(() => {
  setMacShellNativeForTests(undefined);
});

describe("MattrShellMaterial", () => {
  it.effect("keeps solid windows on their solid background without enabling vibrancy", () =>
    Effect.gen(function* () {
      const window = makeFakeWindow();
      yield* applyWindowShellMaterial(window, {
        material: "solid",
        solidBackgroundColor: "#000000",
        platform: "darwin",
      });
      assert.deepEqual(vi.mocked(window.setBackgroundColor).mock.calls, [["#00000000"]]);
      assert.lengthOf(vi.mocked(window.setVibrancy).mock.calls, 0);
      cleanupWindowShellMaterial(window);
    }),
  );

  it.effect(
    "falls back to under-window vibrancy for blur without a native window and clears it",
    () =>
      Effect.gen(function* () {
        const window = makeFakeWindow();
        yield* applyWindowShellMaterial(window, {
          material: "blur",
          solidBackgroundColor: "#000000",
          platform: "darwin",
        });
        assert.deepEqual(vi.mocked(window.setBackgroundColor).mock.calls, [["#00000000"]]);
        assert.deepEqual(vi.mocked(window.setVibrancy).mock.calls, [["under-window"]]);

        yield* applyWindowShellMaterial(window, {
          material: "solid",
          solidBackgroundColor: "#ffffff",
          platform: "darwin",
        });
        assert.deepEqual(vi.mocked(window.setVibrancy).mock.calls, [["under-window"], [null]]);
        assert.deepEqual(vi.mocked(window.setBackgroundColor).mock.calls, [
          ["#00000000"],
          ["#00000000"],
        ]);
        cleanupWindowShellMaterial(window);
      }),
  );

  it.effect("maps Windows materials to acrylic, mica, and none", () =>
    Effect.gen(function* () {
      const window = makeFakeWindow();
      yield* applyWindowShellMaterial(window, {
        material: "blur",
        solidBackgroundColor: "#000000",
        platform: "win32",
      });
      yield* applyWindowShellMaterial(window, {
        material: "liquid-glass",
        solidBackgroundColor: "#000000",
        platform: "win32",
      });
      yield* applyWindowShellMaterial(window, {
        material: "solid",
        solidBackgroundColor: "#000000",
        platform: "win32",
      });
      assert.deepEqual(vi.mocked(window.setBackgroundMaterial).mock.calls, [
        ["acrylic"],
        ["mica"],
        ["none"],
      ]);
      cleanupWindowShellMaterial(window);
    }),
  );

  it.effect("sets the native blur radius for Blur and clears it when leaving", () =>
    Effect.gen(function* () {
      const { native, calls } = makeFakeNative();
      setMacShellNativeForTests(native);
      const window = makeFakeWindow({ native: true });
      const base = { solidBackgroundColor: "#000000", platform: "darwin" as const };
      yield* applyWindowShellMaterial(window, { ...base, material: "blur", blurRadius: 24 });
      yield* applyWindowShellMaterial(window, { ...base, material: "blur", blurRadius: 64 });
      yield* applyWindowShellMaterial(window, { ...base, material: "transparent" });
      assert.deepEqual(calls, [
        ["setBackgroundBlurRadius", CONTENT_VIEW, 24],
        ["setBackgroundBlurRadius", CONTENT_VIEW, 64],
        ["setBackgroundBlurRadius", CONTENT_VIEW, 0],
      ]);
      assert.lengthOf(vi.mocked(window.setVibrancy).mock.calls, 0);
      cleanupWindowShellMaterial(window);
    }),
  );

  it.effect("falls back to vibrancy when the WindowServer blur call is unavailable", () =>
    Effect.gen(function* () {
      const { native } = makeFakeNative({ blurAvailable: false });
      setMacShellNativeForTests(native);
      const window = makeFakeWindow({ native: true });
      yield* applyWindowShellMaterial(window, {
        material: "blur",
        blurRadius: 30,
        solidBackgroundColor: "#000000",
        platform: "darwin",
      });
      assert.deepEqual(vi.mocked(window.setVibrancy).mock.calls, [["under-window"]]);
      cleanupWindowShellMaterial(window);
    }),
  );

  it.effect("passes Liquid Glass style and tint to NSGlassEffectView only when they change", () =>
    Effect.gen(function* () {
      const { native, calls } = makeFakeNative();
      setMacShellNativeForTests(native);
      const window = makeFakeWindow({ native: true });
      const tint = { red: 0.2, green: 0.3, blue: 0.4, alpha: 0.5 };
      const base = { solidBackgroundColor: "#000000", platform: "darwin" as const };
      yield* applyWindowShellMaterial(window, {
        ...base,
        material: "liquid-glass",
        glassStyle: "regular",
        glassTint: null,
      });
      yield* applyWindowShellMaterial(window, {
        ...base,
        material: "liquid-glass",
        glassStyle: "regular",
        glassTint: null,
      });
      yield* applyWindowShellMaterial(window, {
        ...base,
        material: "liquid-glass",
        glassStyle: "clear",
        glassTint: tint,
      });
      yield* applyWindowShellMaterial(window, { ...base, material: "solid" });
      assert.deepEqual(calls, [
        ["setWindowClear", CONTENT_VIEW],
        ["createGlassView", CONTENT_VIEW],
        ["setGlassStyle", GLASS_VIEW, "regular"],
        ["setGlassTint", GLASS_VIEW, null],
        ["setGlassStyle", GLASS_VIEW, "clear"],
        ["setGlassTint", GLASS_VIEW, tint],
        ["removeGlassView", GLASS_VIEW],
      ]);
      assert.lengthOf(vi.mocked(window.setVibrancy).mock.calls, 0);
      cleanupWindowShellMaterial(window);
    }),
  );

  it.effect("uses vibrancy for Liquid Glass before macOS 26", () =>
    Effect.gen(function* () {
      const { native } = makeFakeNative({ glass: false });
      setMacShellNativeForTests(native);
      const window = makeFakeWindow({ native: true });
      yield* applyWindowShellMaterial(window, {
        material: "liquid-glass",
        solidBackgroundColor: "#000000",
        platform: "darwin",
      });
      assert.deepEqual(vi.mocked(window.setVibrancy).mock.calls, [["under-window"]]);
      cleanupWindowShellMaterial(window);
    }),
  );

  it("extends Liquid Glass past every window edge so its rim never draws a second corner", () => {
    const outward = { topAnchor: -1, leadingAnchor: -1, bottomAnchor: 1, trailingAnchor: 1 };
    assert.sameMembers(
      LIQUID_GLASS_EDGE_CONSTRAINTS.map(([anchor]) => anchor),
      Object.keys(outward),
    );
    for (const [anchor, constant] of LIQUID_GLASS_EDGE_CONSTRAINTS) {
      assert.isAtLeast(constant * outward[anchor], 16, anchor);
    }
  });

  it("derives native options from the persisted shell settings", () => {
    const options = shellMaterialOptions(
      {
        ...DEFAULT_SHELL_APPEARANCE,
        shellMaterial: "liquid-glass",
        shellBlur: 100,
        shellGlassStyle: "clear",
        shellColor: "#c0673f",
        shellTransparency: 100,
      },
      true,
    );
    assert.strictEqual(options.material, "liquid-glass");
    assert.strictEqual(options.blurRadius, 64);
    assert.strictEqual(options.glassStyle, "clear");
    assert.strictEqual(options.glassTint?.alpha, 0.15);
    assert.isNull(shellMaterialOptions(DEFAULT_SHELL_APPEARANCE, false).glassTint);
  });

  it.effect("re-applies Blur on first show, once the window has a WindowServer number", () =>
    Effect.gen(function* () {
      let shown = false;
      const { native, calls } = makeFakeNative();
      setMacShellNativeForTests({
        ...native,
        setBackgroundBlurRadius: (view, radius) =>
          shown && native.setBackgroundBlurRadius(view, radius),
      });
      const listeners: Array<() => void> = [];
      const window = Object.assign(makeFakeWindow({ native: true }), {
        isVisible: () => shown,
        once: (_event: string, listener: () => void) => void listeners.push(listener),
      }) as unknown as Electron.BrowserWindow;
      yield* applyWindowShellMaterial(window, {
        material: "blur",
        blurRadius: 40,
        solidBackgroundColor: "#000000",
        platform: "darwin",
      });
      assert.deepEqual(vi.mocked(window.setVibrancy).mock.calls, [["under-window"]]);
      assert.lengthOf(listeners, 1);

      shown = true;
      for (const listener of listeners) listener();
      yield* Effect.promise(() => new Promise<void>((resolve) => queueMicrotask(resolve)));
      yield* Effect.yieldNow;
      assert.deepEqual(calls.at(-1), ["setBackgroundBlurRadius", CONTENT_VIEW, 40]);
      assert.deepEqual(vi.mocked(window.setVibrancy).mock.calls, [["under-window"], [null]]);
      cleanupWindowShellMaterial(window);
    }),
  );

  it.effect("falls back to vibrancy when a native call throws", () =>
    Effect.gen(function* () {
      const { native } = makeFakeNative();
      setMacShellNativeForTests({
        ...native,
        createGlassView: () => {
          throw new Error("ffi failure");
        },
      });
      const window = makeFakeWindow({ native: true });
      yield* applyWindowShellMaterial(window, {
        material: "liquid-glass",
        solidBackgroundColor: "#000000",
        platform: "darwin",
      });
      assert.deepEqual(vi.mocked(window.setVibrancy).mock.calls, [["under-window"]]);
      cleanupWindowShellMaterial(window);
    }),
  );
});
