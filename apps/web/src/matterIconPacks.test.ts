// oxlint-disable-next-line no-restricted-imports -- checks every mapped name exists, pull request glyphs included
import * as Lucide from "lucide-react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ICON_FAMILIES, PACK_ICON_NAMES } from "../../../matter/icons/icon-pack-map";
import {
  ICONIFY_PACKS,
  hasIconifyIcon,
  packGlyphs,
  packIconName,
  readIconifySet,
} from "../../../matter/icons/iconify-packs";
import type { IconPackSource } from "../../../matter/icons/iconPack";
import { SF_SYMBOL_FOR_LUCIDE } from "../../../matter/icons/sf-symbol-map";
import { createMemoryStorage } from "./lib/storage";

const WEB_ROOT = `${import.meta.dirname}/..`;
const lucideNames = Object.keys(SF_SYMBOL_FOR_LUCIDE);
const sources = Object.keys(ICONIFY_PACKS) as IconPackSource[];

describe("icon pack map", () => {
  it("covers every icon the SF Symbols map swaps, and only real lucide exports", () => {
    expect(Object.keys(PACK_ICON_NAMES).toSorted()).toEqual(lucideNames.toSorted());
    expect(lucideNames.filter((name) => !(name in Lucide))).toEqual([]);
  });

  it("names only icons the installed sets have", () => {
    const missing: string[] = [];
    ICON_FAMILIES.forEach((family, column) => {
      const set = readIconifySet(WEB_ROOT, family);
      const suffixes = new Set(
        Object.values(ICONIFY_PACKS).flatMap((pack) =>
          pack.family === family ? [...pack.suffixes, ...(pack.openSuffixes ?? [])] : [],
        ),
      );
      if (family === "ph") for (const style of ["-duotone", "-bold"]) suffixes.add(style);
      for (const [lucideName, names] of Object.entries(PACK_ICON_NAMES)) {
        const base = names[column];
        if (base && ![...suffixes].some((suffix) => hasIconifyIcon(set, base + suffix))) {
          missing.push(`${family}:${base} (${lucideName})`);
        }
      }
    });
    expect(missing).toEqual([]);
  });

  it("keeps folders solid while arrows and chevrons take line cuts", () => {
    const ph = readIconifySet(WEB_ROOT, "ph");
    const ri = readIconifySet(WEB_ROOT, "ri");
    expect(packIconName(ph, "phosphor-fill", "FolderIcon")).toBe("folder-fill");
    expect(packIconName(ri, "remix-fill", "FolderOpenIcon")).toMatch(/-fill$/);
    expect(packIconName(ph, "phosphor-fill", "ChevronDownIcon")).toMatch(/-bold$/);
  });

  it("draws every swapped icon in every solid pack", () => {
    const gaps = sources
      .filter((source) => ICONIFY_PACKS[source].fallback !== null || source === "phosphor-fill")
      .flatMap((source) => {
        const glyphs = packGlyphs(WEB_ROOT, source, lucideNames);
        return lucideNames.filter((name) => !glyphs[name]).map((name) => `${source} ${name}`);
      });
    expect(gaps).toEqual([]);
  });
});

describe("icon pack store", () => {
  let localStorage: ReturnType<typeof createMemoryStorage>;
  beforeEach(() => {
    localStorage = createMemoryStorage();
    vi.stubGlobal("localStorage", localStorage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the last pack on screen until a lazy pack loads, then switches", async () => {
    vi.resetModules();
    const store = await import("../../../matter/icons/iconPack");
    expect(store.getIconPackState()).toMatchObject({
      requested: "sf-symbols-fill",
      shown: "sf-symbols-fill",
    });

    let resolveSolar: (module: {
      icons: Record<string, readonly [string, string]>;
    }) => void = () => {};
    store.registerIconPackLoaders({
      "solar-bold": () =>
        new Promise((resolve) => {
          resolveSolar = resolve;
        }),
    });
    const changes = vi.fn();
    const unsubscribe = store.subscribeIconPack(changes);

    store.setIconPack("solar-bold");
    expect(localStorage.getItem("mattr:icon-pack:v1")).toBe("solar-bold");
    expect(store.getIconPackState()).toMatchObject({
      requested: "solar-bold",
      shown: "sf-symbols-fill",
    });

    const gear = ["<path/>", "0 0 24 24"] as const;
    resolveSolar({ icons: { SettingsIcon: gear } });
    await vi.waitFor(() => expect(store.getIconPackState().shown).toBe("solar-bold"));
    expect(store.getIconPackState().sources["solar-bold"]).toEqual({ SettingsIcon: gear });

    store.setIconPack("lucide-orca");
    expect(store.getIconPackState()).toMatchObject({
      requested: "lucide-orca",
      shown: "lucide-orca",
    });
    expect(changes).toHaveBeenCalled();
    unsubscribe();
  });

  it("draws lucide when a pack fails to load", async () => {
    localStorage.setItem("mattr:icon-pack:v1", "tabler-filled");
    vi.resetModules();
    const store = await import("../../../matter/icons/iconPack");
    expect(store.getIconPackState()).toMatchObject({ requested: "tabler-filled", shown: null });

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    store.registerIconPackLoaders({
      "tabler-filled": () => Promise.reject(new Error("offline")),
    });
    await vi.waitFor(() => expect(store.getIconPackState().shown).toBe("tabler-filled"));
    expect(store.getIconPackState().failed["tabler-filled"]).toBe(true);
    expect(store.getIconPackState().sources["tabler-filled"]).toBeUndefined();
    warn.mockRestore();
  });

  it("starts on the default pack when a saved pack no longer exists", async () => {
    localStorage.setItem("mattr:icon-pack:v1", "iconoir");
    vi.resetModules();
    const store = await import("../../../matter/icons/iconPack");
    expect(store.getIconPack()).toBe("sf-symbols-fill");
  });
});
