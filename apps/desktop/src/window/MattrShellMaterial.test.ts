import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as Electron from "electron";
import { vi } from "vite-plus/test";

import { applyWindowShellMaterial, cleanupWindowShellMaterial } from "./MattrShellMaterial.ts";

function makeFakeWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    setBackgroundColor: vi.fn(),
    setVibrancy: vi.fn(),
    setBackgroundMaterial: vi.fn(),
  } as unknown as Electron.BrowserWindow;
}

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

  it.effect("applies macOS under-window vibrancy for blur and clears it back to solid", () =>
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
});
