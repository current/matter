import { beforeEach, describe, expect, it } from "vite-plus/test";
import { DEFAULT_ISLAND_SETTINGS } from "../../../../antimatter/island/types";
import { getIslandSettings, updateIslandSettings } from "./islandSettingsStore";

describe("islandSettingsStore", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
  });

  it("defaults to enabled with single-tap Control shortcut and notch notifications", () => {
    expect(getIslandSettings()).toEqual({
      enabled: true,
      shortcut: "control",
      showNotifications: true,
      showMessages: true,
    });
  });

  it("updates partial settings cleanly", () => {
    const next = updateIslandSettings({ shortcut: "option", showMessages: false });
    expect(next.shortcut).toBe("option");
    expect(next.showMessages).toBe(false);
    expect(next.enabled).toBe(true);
    expect(getIslandSettings()).toEqual(next);
  });
});
