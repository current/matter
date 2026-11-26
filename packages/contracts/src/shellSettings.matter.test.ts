import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ClientSettingsPatch, ClientSettingsSchema, DEFAULT_CLIENT_SETTINGS } from "./settings.ts";

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodePatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("mattr shell settings", () => {
  it("fills defaults for settings files written before the shell controls existed", () => {
    const decoded = decodeClientSettings({ shellMaterial: "blur", shellGrain: 20 });
    expect(decoded.shellMaterial).toBe("blur");
    expect(decoded.shellTransparency).toBe(50);
    expect(decoded.shellBlur).toBe(60);
    expect(decoded.shellGlassStyle).toBe("regular");
    expect(decoded.shellColor).toBeNull();
    expect(DEFAULT_CLIENT_SETTINGS.shellColor).toBeNull();
  });

  it("round-trips a custom color and the native intensity controls", () => {
    const decoded = decodeClientSettings({
      shellMaterial: "liquid-glass",
      shellTransparency: 85,
      shellBlur: 0,
      shellGlassStyle: "clear",
      shellColor: "#3f6e8c",
    });
    expect(decoded).toMatchObject({
      shellTransparency: 85,
      shellBlur: 0,
      shellGlassStyle: "clear",
      shellColor: "#3f6e8c",
    });
    expect(decodePatch({ shellColor: null })).toEqual({ shellColor: null });
  });

  it("rejects colors and amounts the frame can't render", () => {
    expect(() => decodePatch({ shellColor: "#ABCDEF" })).toThrow();
    expect(() => decodePatch({ shellColor: "red" })).toThrow();
    expect(() => decodePatch({ shellTransparency: 101 })).toThrow();
    expect(() => decodePatch({ shellBlur: -1 })).toThrow();
    expect(() => decodePatch({ shellGlassStyle: "frosted" })).toThrow();
  });
});
