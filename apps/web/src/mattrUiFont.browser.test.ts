import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { DEFAULT_CODE_FONT_STACK, DEFAULT_SANS_FONT_STACK } from "./appearanceFonts";
import { writeLocalStorageValue } from "./hooks/useLocalStorage";
import {
  applyMattrUiFont,
  DEFAULT_MATTR_UI_FONT,
  MATTR_UI_FONT_LOADERS,
  MATTR_UI_FONT_STORAGE_KEY,
  MATTR_UI_FONTS,
  MattrUiFont,
  mattrUiFontDefinition,
  readMattrUiFont,
  startMattrUiFont,
  SYSTEM_STAND_IN,
} from "./mattrUiFont";

const root = document.documentElement;
const renderedSans = () => getComputedStyle(document.body).getPropertyValue("--font-sans").trim();

/** Restores the default font, storage and Typography override when the test ends. */
function fontScope(): Disposable {
  return {
    [Symbol.dispose]() {
      localStorage.removeItem(MATTR_UI_FONT_STORAGE_KEY);
      applyMattrUiFont(root, DEFAULT_MATTR_UI_FONT);
      root.style.removeProperty("--font-sans");
    },
  };
}

describe("mattr UI font", () => {
  it("offers every face once, with the licensed family first and a bundled stand-in after it", () => {
    expect(MATTR_UI_FONTS.map((font) => font.id)).toEqual(MattrUiFont.literals);
    for (const font of MATTR_UI_FONTS) {
      if (font.localFamily) expect(font.stack.startsWith(`"${font.localFamily}"`)).toBe(true);
      if (font.standIn && font.standIn !== SYSTEM_STAND_IN) {
        expect(font.stack).toContain(font.standIn);
        expect(MATTR_UI_FONT_LOADERS[font.id]).toBeTypeOf("function");
      }
    }
    expect(mattrUiFontDefinition("system").stack).toBe(DEFAULT_SANS_FONT_STACK);
    expect(mattrUiFontDefinition("berkeley-mono").stack.endsWith(DEFAULT_CODE_FONT_STACK)).toBe(
      true,
    );
  });

  it("loads every bundled stand-in as its own font-face", async () => {
    await Promise.all(Object.values(MATTR_UI_FONT_LOADERS).map((load) => load()));
    const families = new Set([...document.fonts].map((face) => face.family.replaceAll('"', "")));
    for (const family of [
      "Geist Variable",
      "IBM Plex Sans",
      "Figtree Variable",
      "Source Sans 3 Variable",
      "Inter Tight Variable",
      "Google Sans Flex Variable",
      "Commit Mono",
    ]) {
      expect(families).toContain(family);
    }
  });

  it("keeps the default free: no loader, no attribute, no override", () => {
    using _scope = fontScope();
    expect(MATTR_UI_FONT_LOADERS.system).toBeUndefined();
    expect(MATTR_UI_FONT_LOADERS.inter).toBeUndefined();
    expect(MATTR_UI_FONT_LOADERS["sf-pro-text"]).toBeUndefined();
    applyMattrUiFont(root, "system");
    expect(root.dataset.mattrUiFont).toBeUndefined();
    expect(document.getElementById("mattr-ui-font")).toBeNull();
  });

  it("overrides the interface font, even over Typography's inline custom font", () => {
    using _scope = fontScope();
    root.style.setProperty("--font-sans", '"Comic Sans MS", sans-serif');
    applyMattrUiFont(root, "geist");
    expect(root.dataset.mattrUiFont).toBe("geist");
    expect(renderedSans()).toContain('"Geist"');

    applyMattrUiFont(root, "system");
    expect(renderedSans()).toContain("Comic Sans MS");
  });

  it("restores the saved font on start and follows later writes", () => {
    using _scope = fontScope();
    writeLocalStorageValue(MATTR_UI_FONT_STORAGE_KEY, "ibm-plex-sans", "system", MattrUiFont);
    using _font = { [Symbol.dispose]: startMattrUiFont(root) };
    expect(readMattrUiFont()).toBe("ibm-plex-sans");
    expect(renderedSans()).toContain("IBM Plex Sans");

    writeLocalStorageValue(MATTR_UI_FONT_STORAGE_KEY, "berkeley-mono", "system", MattrUiFont);
    expect(root.dataset.mattrUiFont).toBe("berkeley-mono");
    expect(renderedSans()).toContain("Berkeley Mono");
  });

  it("falls back to the default when storage holds an unknown font", () => {
    using _scope = fontScope();
    localStorage.setItem(MATTR_UI_FONT_STORAGE_KEY, JSON.stringify("papyrus"));
    expect(readMattrUiFont()).toBe(DEFAULT_MATTR_UI_FONT);
  });
});
