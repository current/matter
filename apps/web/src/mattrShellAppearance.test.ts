import { describe, expect, it } from "vite-plus/test";
import { applyMattrShellAppearance, buildMattrShellGrainDataUrl } from "./mattrShellAppearance";

function makeFakeRoot() {
  const dataset: Record<string, string | undefined> = {};
  const properties = new Map<string, string>();
  return {
    dataset,
    style: {
      setProperty(name: string, value: string) {
        properties.set(name, value);
      },
      removeProperty(name: string) {
        properties.delete(name);
      },
      getPropertyValue(name: string) {
        return properties.get(name) ?? "";
      },
    },
  } as unknown as HTMLElement;
}

describe("mattrShellAppearance", () => {
  it("returns none when grain is 0 and builds a monochrome SVG tile when positive", () => {
    expect(buildMattrShellGrainDataUrl(0)).toBe("none");
    expect(buildMattrShellGrainDataUrl(-10)).toBe("none");

    const medium = buildMattrShellGrainDataUrl(50);
    expect(medium).toContain('url("data:image/svg+xml,');
    expect(decodeURIComponent(medium)).toContain("feTurbulence");
    expect(decodeURIComponent(medium)).toContain("saturate");
    expect(decodeURIComponent(medium)).toContain("opacity='0.0600'");

    const full = buildMattrShellGrainDataUrl(100);
    expect(decodeURIComponent(full)).toContain("opacity='0.1200'");
  });

  it("applies and clears data attributes and CSS variable on the document root", () => {
    const root = makeFakeRoot();
    applyMattrShellAppearance(root, { shellMaterial: "liquid-glass", shellGrain: 45 });
    expect(root.dataset.mattrShellMaterial).toBe("liquid-glass");
    expect(root.dataset.mattrShellGrain).toBe("on");
    expect(root.style.getPropertyValue("--mattr-shell-grain")).toContain("data:image/svg+xml");

    applyMattrShellAppearance(root, { shellMaterial: "solid", shellGrain: 0 });
    expect(root.dataset.mattrShellMaterial).toBe("solid");
    expect(root.dataset.mattrShellGrain).toBeUndefined();
    expect(root.style.getPropertyValue("--mattr-shell-grain")).toBe("");
  });
});
