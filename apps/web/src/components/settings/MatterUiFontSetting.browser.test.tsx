import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { isFontFamilyAvailable } from "../../appearanceFonts";
import {
  applyMatterUiFont,
  DEFAULT_MATTER_UI_FONT,
  MATTER_UI_FONT_STORAGE_KEY,
  MATTER_UI_FONTS,
  matterUiFontDefinition,
  readMatterUiFont,
  startMatterUiFont,
} from "../../matterUiFont";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ children, resetAction }) => (
    <div>
      {resetAction}
      {children}
    </div>
  ),
}));

import { MatterUiFontSetting } from "./MatterUiFontSetting";

describe("MatterUiFontSetting", () => {
  it("previews each face in itself and applies a pick across the app at once", async () => {
    const stop = startMatterUiFont();
    using _font = {
      [Symbol.dispose]: () => {
        stop();
        localStorage.removeItem(MATTER_UI_FONT_STORAGE_KEY);
        applyMatterUiFont(document.documentElement, DEFAULT_MATTER_UI_FONT);
      },
    };
    await using _screen = await render(<MatterUiFontSetting />, { router: false });
    const options = page.getByRole("radio");
    await expect.poll(() => options.elements().length).toBe(MATTER_UI_FONTS.length);
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
    expect(readMatterUiFont()).toBe("geist");
    expect(document.documentElement.dataset.matterUiFont).toBe("geist");

    await userEvent.click(page.getByRole("button", { name: "Reset UI font to default" }));
    expect(readMatterUiFont()).toBe(DEFAULT_MATTER_UI_FONT);
    expect(document.documentElement.dataset.matterUiFont).toBeUndefined();
  });

  // Regression: the app font must change on click even when no entry hook subscribed to storage.
  it.each([
    ["berkeley-mono", "Commit Mono"],
    ["ibm-plex-sans", "IBM Plex Sans"],
    ["geist", "Geist Variable"],
  ] as const)(
    "clicking %s loads %s and re-renders the whole interface in it, across a reload",
    async (id, family) => {
      using _font = {
        [Symbol.dispose]: () => {
          localStorage.removeItem(MATTER_UI_FONT_STORAGE_KEY);
          applyMatterUiFont(document.documentElement, DEFAULT_MATTER_UI_FONT);
        },
      };
      const sample = document.body.appendChild(document.createElement("span"));
      sample.textContent = "Ship the agent. mmmmMMWli1O0@# fjord";
      using _sample = { [Symbol.dispose]: () => sample.remove() };
      await document.fonts.ready;
      const defaultWidth = sample.getBoundingClientRect().width;

      await using _screen = await render(<MatterUiFontSetting />, { router: false });
      const option = page.getByRole("radio", {
        name: new RegExp(`^${matterUiFontDefinition(id).name}`),
      });
      await userEvent.click(option);
      await expect.element(option).toBeChecked();

      expect(readMatterUiFont()).toBe(id);
      expect(getComputedStyle(document.body).fontFamily).toContain(
        matterUiFontDefinition(id).stack.split(",")[0]!.replaceAll('"', ""),
      );
      await expect
        .poll(() =>
          [...document.fonts].some(
            (face) => face.family.replaceAll('"', "") === family && face.status === "loaded",
          ),
        )
        .toBe(true);
      expect(getComputedStyle(document.body).fontFamily).toContain(family);
      await expect.poll(() => sample.getBoundingClientRect().width).not.toBe(defaultWidth);

      // A reload drops the injected rule; the saved pick brings it back before first render.
      document.getElementById("matter-ui-font")?.remove();
      delete document.documentElement.dataset.matterUiFont;
      startMatterUiFont()();
      expect(document.documentElement.dataset.matterUiFont).toBe(id);
      expect(getComputedStyle(document.body).fontFamily).toContain(family);
    },
  );

  it("can't pick SF Pro Text while it isn't installed, since it would render as the default", async () => {
    await using _screen = await render(<MatterUiFontSetting />, { router: false });
    const sfPro = page.getByRole("radio", { name: /^SF Pro Text/ });
    await expect.element(sfPro).toBeVisible();
    if (isFontFamilyAvailable("SF Pro Text")) {
      await expect.element(sfPro).toBeEnabled();
    } else {
      await expect.element(sfPro).toBeDisabled();
      expect(sfPro.element().textContent).toContain("Not installed");
    }
  });
});
