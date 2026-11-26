import { render } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import {
  DEFAULT_ICON_PACK,
  ICON_PACK_OPTIONS,
  getIconPack,
  setIconPack,
} from "../../../../../matter/icons/iconPack";
import { useMatterIconPack } from "../../matterIconPack";

vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsRow: ({ control, resetAction }) => (
    <div>
      {resetAction}
      {control}
    </div>
  ),
}));

import { MatterIconPackSetting } from "./MatterIconPackSetting";

function PackProbe() {
  return <output data-testid="pack-probe">{useMatterIconPack()}</output>;
}

describe("MatterIconPackSetting", () => {
  it("switches every subscriber to a picked pack at once and saves it on the device", async () => {
    using _pack = {
      [Symbol.dispose]: () => {
        setIconPack(DEFAULT_ICON_PACK);
        localStorage.removeItem("mattr:icon-pack:v1");
      },
    };
    await using _screen = await render(
      <>
        <MatterIconPackSetting />
        <PackProbe />
      </>,
      { router: false },
    );
    const trigger = page.getByRole("combobox", { name: "Icon pack" });
    const probe = page.getByTestId("pack-probe");
    await expect.element(trigger).toHaveTextContent("SF Symbols Fill");
    await expect.element(probe).toHaveTextContent(DEFAULT_ICON_PACK);

    await userEvent.click(trigger);
    await expect
      .poll(() => page.getByRole("option").elements().length)
      .toBe(ICON_PACK_OPTIONS.length);
    await userEvent.click(page.getByRole("option", { name: /^Solar Bold · Clonk/ }));

    await expect.element(probe).toHaveTextContent("solar-bold");
    await expect.element(trigger).toHaveTextContent("Solar Bold · Clonk");
    expect(getIconPack()).toBe("solar-bold");
    expect(localStorage.getItem("mattr:icon-pack:v1")).toBe("solar-bold");

    await userEvent.click(page.getByRole("button", { name: "Reset icon pack to default" }));
    await expect.element(probe).toHaveTextContent(DEFAULT_ICON_PACK);
    expect(localStorage.getItem("mattr:icon-pack:v1")).toBe(DEFAULT_ICON_PACK);
  });
});
