import { describe, expect, it } from "vite-plus/test";
import { adaptShellColor } from "../../../matter/shellTint";
import { applyMatterShellAppearance, buildMatterShellGrainDataUrl } from "./matterShellAppearance";

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

describe("matterShellAppearance", () => {
  it("returns none when grain is 0 and builds a monochrome SVG tile when positive", () => {
    expect(buildMatterShellGrainDataUrl(0)).toBe("none");
    expect(buildMatterShellGrainDataUrl(-10)).toBe("none");

    const medium = buildMatterShellGrainDataUrl(50);
    expect(medium).toContain('url("data:image/svg+xml,');
    expect(decodeURIComponent(medium)).toContain("feTurbulence");
    expect(decodeURIComponent(medium)).toContain("saturate");
    expect(decodeURIComponent(medium)).toContain("opacity='0.0600'");

    const full = buildMatterShellGrainDataUrl(100);
    expect(decodeURIComponent(full)).toContain("opacity='0.1200'");
  });

  it("applies and clears data attributes and CSS variable on the document root", () => {
    const root = makeFakeRoot();
    applyMatterShellAppearance(root, {
      shellMaterial: "liquid-glass",
      shellGrain: 45,
      shellTransparency: 50,
      shellColor: null,
    });
    expect(root.dataset.matterShellMaterial).toBe("liquid-glass");
    expect(root.dataset.matterShellGrain).toBe("on");
    expect(root.style.getPropertyValue("--matter-shell-grain")).toContain("data:image/svg+xml");

    applyMatterShellAppearance(root, {
      shellMaterial: "solid",
      shellGrain: 0,
      shellTransparency: 50,
      shellColor: null,
    });
    expect(root.dataset.matterShellMaterial).toBe("solid");
    expect(root.dataset.matterShellGrain).toBeUndefined();
    expect(root.style.getPropertyValue("--matter-shell-grain")).toBe("");
  });

  it("drives the frame opacity from the material and transparency", () => {
    const root = makeFakeRoot();
    applyMatterShellAppearance(root, {
      shellMaterial: "transparent",
      shellGrain: 0,
      shellTransparency: 100,
      shellColor: null,
    });
    expect(root.style.getPropertyValue("--matter-shell-opacity")).toBe("0%");

    applyMatterShellAppearance(root, {
      shellMaterial: "transparent",
      shellGrain: 0,
      shellTransparency: 0,
      shellColor: null,
    });
    expect(root.style.getPropertyValue("--matter-shell-opacity")).toBe("96%");

    applyMatterShellAppearance(root, {
      shellMaterial: "solid",
      shellGrain: 0,
      shellTransparency: 100,
      shellColor: null,
    });
    expect(root.style.getPropertyValue("--matter-shell-opacity")).toBe("100%");
  });

  it("sets theme-fitted tint variables for a shell color and clears them on reset", () => {
    const root = makeFakeRoot();
    applyMatterShellAppearance(root, {
      shellMaterial: "solid",
      shellGrain: 0,
      shellTransparency: 50,
      shellColor: "#3f6e8c",
    });
    expect(root.dataset.matterShellTint).toBe("on");
    expect(root.style.getPropertyValue("--matter-shell-tint-light")).toBe(
      adaptShellColor("#3f6e8c", "light"),
    );
    expect(root.style.getPropertyValue("--matter-shell-tint-dark")).toBe(
      adaptShellColor("#3f6e8c", "dark"),
    );

    applyMatterShellAppearance(root, {
      shellMaterial: "solid",
      shellGrain: 0,
      shellTransparency: 50,
      shellColor: null,
    });
    expect(root.dataset.matterShellTint).toBeUndefined();
    expect(root.style.getPropertyValue("--matter-shell-tint-light")).toBe("");
    expect(root.style.getPropertyValue("--matter-shell-tint-dark")).toBe("");
  });
});
