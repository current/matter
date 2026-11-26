import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { DEFAULT_CODE_FONT_STACK, DEFAULT_SANS_FONT_STACK } from "./appearanceFonts";
import { writeLocalStorageValue } from "./hooks/useLocalStorage";
import {
  applyMatterUiFont,
  DEFAULT_MATTER_UI_FONT,
  MATTER_UI_FONT_LOADERS,
  MATTER_UI_FONT_STORAGE_KEY,
  MATTER_UI_FONTS,
  MatterUiFont,
  matterUiFontDefinition,
  readMatterUiFont,
  startMatterUiFont,
  SYSTEM_STAND_IN,
} from "./matterUiFont";

const root = document.documentElement;
const renderedSans = () => getComputedStyle(document.body).getPropertyValue("--font-sans").trim();

/** Restores the default font, storage and Typography override when the test ends. */
function fontScope(): Disposable {
  return {
    [Symbol.dispose]() {
      localStorage.removeItem(MATTER_UI_FONT_STORAGE_KEY);
      applyMatterUiFont(root, DEFAULT_MATTER_UI_FONT);
      root.style.removeProperty("--font-sans");
    },
  };
}

describe("Matter UI font", () => {
  it("offers every face once, with the licensed family first and a bundled stand-in after it", () => {
    expect(MATTER_UI_FONTS.map((font) => font.id)).toEqual(MatterUiFont.literals);
    for (const font of MATTER_UI_FONTS) {
      if (font.localFamily) expect(font.stack.startsWith(`"${font.localFamily}"`)).toBe(true);
      if (font.standIn && font.standIn !== SYSTEM_STAND_IN) {
        expect(font.stack).toContain(font.standIn);
        expect(MATTER_UI_FONT_LOADERS[font.id]).toBeTypeOf("function");
      }
    }
    expect(matterUiFontDefinition("system").stack).toBe(DEFAULT_SANS_FONT_STACK);
    expect(matterUiFontDefinition("berkeley-mono").stack.endsWith(DEFAULT_CODE_FONT_STACK)).toBe(
      true,
    );
  });

  it("loads every bundled stand-in as its own font-face", async () => {
    await Promise.all(Object.values(MATTER_UI_FONT_LOADERS).map((load) => load()));
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
    expect(MATTER_UI_FONT_LOADERS.system).toBeUndefined();
    expect(MATTER_UI_FONT_LOADERS.inter).toBeUndefined();
    expect(MATTER_UI_FONT_LOADERS["sf-pro-text"]).toBeUndefined();
    applyMatterUiFont(root, "system");
    expect(root.dataset.matterUiFont).toBeUndefined();
    expect(document.getElementById("matter-ui-font")).toBeNull();
  });

  it("overrides the interface font, even over Typography's inline custom font", () => {
    using _scope = fontScope();
    root.style.setProperty("--font-sans", '"Comic Sans MS", sans-serif');
    applyMatterUiFont(root, "geist");
    expect(root.dataset.matterUiFont).toBe("geist");
    expect(renderedSans()).toContain('"Geist"');

    applyMatterUiFont(root, "system");
    expect(renderedSans()).toContain("Comic Sans MS");
  });

  it("restores the saved font on start and follows later writes", () => {
    using _scope = fontScope();
    writeLocalStorageValue(MATTER_UI_FONT_STORAGE_KEY, "ibm-plex-sans", "system", MatterUiFont);
    using _font = { [Symbol.dispose]: startMatterUiFont(root) };
    expect(readMatterUiFont()).toBe("ibm-plex-sans");
    expect(renderedSans()).toContain("IBM Plex Sans");

    writeLocalStorageValue(MATTER_UI_FONT_STORAGE_KEY, "berkeley-mono", "system", MatterUiFont);
    expect(root.dataset.matterUiFont).toBe("berkeley-mono");
    expect(renderedSans()).toContain("Berkeley Mono");
  });

  it("falls back to the default when storage holds an unknown font", () => {
    using _scope = fontScope();
    localStorage.setItem(MATTER_UI_FONT_STORAGE_KEY, JSON.stringify("papyrus"));
    expect(readMatterUiFont()).toBe(DEFAULT_MATTER_UI_FONT);
  });
});
