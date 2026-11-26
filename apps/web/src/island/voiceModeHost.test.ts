import { describe, expect, it } from "vite-plus/test";

import { electVoiceModeHost } from "./voiceModeHost";

describe("electVoiceModeHost", () => {
  const first = { id: Symbol("first"), threadKey: "env:a" };
  const second = { id: Symbol("second"), threadKey: "env:b" };

  it("prefers the composer showing the scoped thread", () => {
    expect(electVoiceModeHost([first, second], "env:b")).toBe(second.id);
  });

  it("falls back to the first composer on screen", () => {
    expect(electVoiceModeHost([first, second], "env:c")).toBe(first.id);
    expect(electVoiceModeHost([first, second], null)).toBe(first.id);
  });

  it("elects nobody when no composer is on screen", () => {
    expect(electVoiceModeHost([], "env:a")).toBeNull();
  });
});
