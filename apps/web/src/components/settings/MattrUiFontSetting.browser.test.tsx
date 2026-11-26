import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import {
  applyMattrUiFont,
  DEFAULT_MATTR_UI_FONT,
  MATTR_UI_FONT_STORAGE_KEY,
  MATTR_UI_FONTS,
  readMattrUiFont,
  startMattrUiFont,
} from "../../mattrUiFont";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ children, resetAction }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
}));

import { MattrUiFontSetting } from "./MattrUiFontSetting";

describe("MattrUiFontSetting", () => {
  it("previews each face in itself and applies a pick across the app at once", async () => {
    const stop = startMattrUiFont();
    using _font = {
      [Symbol.dispose]: () => {
        stop();
        localStorage.removeItem(MATTR_UI_FONT_STORAGE_KEY);
        applyMattrUiFont(document.documentElement, DEFAULT_MATTR_UI_FONT);
      },
    };
    await using _screen = await render(<MattrUiFontSetting />, { router: false });
    const options = page.getByRole("radio");
    await expect.poll(() => options.elements().length).toBe(MATTR_UI_FONTS.length);
    await expect.element(page.getByRole("radio", { name: /^SF Pro \/ system-ui/ })).toBeChecked();

    const geist = page.getByRole("radio", { name: /^Geist/ });
    const preview = geist.element().querySelector<HTMLElement>("[aria-hidden]:last-child");
    expect(preview?.style.fontFamily).toContain("Geist");
    expect(geist.element().textContent).not.toContain("stand-in");
    expect(page.getByRole("radio", { name: /^Anthropic Sans/ }).element().textContent).toMatch(
      /Source Sans 3 stand-in|Installed/,
    );

    await userEvent.click(geist);
    await expect.element(geist).toBeChecked();
    expect(readMattrUiFont()).toBe("geist");
    expect(document.documentElement.dataset.mattrUiFont).toBe("geist");

    await userEvent.click(page.getByRole("button", { name: "Reset UI font to default" }));
    expect(readMattrUiFont()).toBe(DEFAULT_MATTR_UI_FONT);
    expect(document.documentElement.dataset.mattrUiFont).toBeUndefined();
  });
});
