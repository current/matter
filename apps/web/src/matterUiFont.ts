import * as Schema from "effect/Schema";

import { DEFAULT_CODE_FONT_STACK, DEFAULT_SANS_FONT_STACK } from "./appearanceFonts";
import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  useLocalStorage,
} from "./hooks/useLocalStorage";

export const MATTER_UI_FONT_STORAGE_KEY = "mattr:ui-font:v1";

export const MatterUiFont = Schema.Literals([
  "system",
  "sf-pro-text",
  "geist",
  "inter",
  "ibm-plex-sans",
  "allo",
  "anthropic-sans",
  "jetbrains-sans",
  "google-sans-flex",
  "berkeley-mono",
]);
export type MatterUiFont = typeof MatterUiFont.Type;

export const DEFAULT_MATTER_UI_FONT: MatterUiFont = "system";

/** A stand-in the OS supplies, so nothing is bundled for it. */
export const SYSTEM_STAND_IN = "system-ui";

export interface MatterUiFontDefinition {
  readonly id: MatterUiFont;
  readonly name: string;
  readonly usedBy: string;
  readonly stack: string;
  /** The licensed face, used first when it is installed on this machine. */
  readonly localFamily?: string;
  /** The bundled open face used when the licensed one is not installed. */
  readonly standIn?: string;
  readonly mono?: boolean;
}

export const MATTER_UI_FONTS: readonly MatterUiFontDefinition[] = [
  {
    id: "system",
    name: "SF Pro / system-ui",
    usedBy: "T3 Code, Cursor, Warp, Codex",
    stack: DEFAULT_SANS_FONT_STACK,
  },
  {
    id: "sf-pro-text",
    name: "SF Pro Text",
    usedBy: "Apple's text optical size",
    localFamily: "SF Pro Text",
    // macOS doesn't expose its system face by name, so without Apple's SF Pro download this is
    // the system font.
    standIn: SYSTEM_STAND_IN,
    stack: `"SF Pro Text", -apple-system, BlinkMacSystemFont, system-ui, sans-serif`,
  },
  {
    id: "geist",
    name: "Geist",
    usedBy: "Orca, Factory, Conductor, Cmux",
    stack: `"Geist", "Geist Variable", ${DEFAULT_SANS_FONT_STACK}`,
  },
  {
    id: "inter",
    name: "Inter",
    usedBy: "OpenCode desktop, HB Code",
    stack: `"Inter Variable", "Inter", ${DEFAULT_SANS_FONT_STACK}`,
  },
  {
    id: "ibm-plex-sans",
    name: "IBM Plex Sans",
    usedBy: "Zed Delta, Vibe Kanban",
    stack: `"IBM Plex Sans", ${DEFAULT_SANS_FONT_STACK}`,
  },
  {
    id: "allo",
    name: "Allo",
    usedBy: "Threadbear",
    localFamily: "Allo",
    standIn: "Figtree",
    stack: `"Allo", "Figtree Variable", ${DEFAULT_SANS_FONT_STACK}`,
  },
  {
    id: "anthropic-sans",
    name: "Anthropic Sans",
    usedBy: "Claude Code Desktop",
    localFamily: "Anthropic Sans",
    standIn: "Source Sans 3",
    stack: `"Anthropic Sans", "Source Sans 3 Variable", ${DEFAULT_SANS_FONT_STACK}`,
  },
  {
    id: "jetbrains-sans",
    name: "JetBrains Sans",
    usedBy: "JetBrains Air",
    localFamily: "JetBrains Sans",
    standIn: "Inter Tight",
    stack: `"JetBrains Sans", "Inter Tight Variable", ${DEFAULT_SANS_FONT_STACK}`,
  },
  {
    id: "google-sans-flex",
    name: "Google Sans Flex",
    usedBy: "Antigravity",
    stack: `"Google Sans Flex", "Google Sans Flex Variable", ${DEFAULT_SANS_FONT_STACK}`,
  },
  {
    id: "berkeley-mono",
    name: "Berkeley Mono as UI",
    usedBy: "Amp",
    localFamily: "Berkeley Mono",
    standIn: "Commit Mono",
    mono: true,
    stack: `"Berkeley Mono", "TX-02", "Commit Mono", ${DEFAULT_CODE_FONT_STACK}`,
  },
];

const FONTS_BY_ID = new Map(MATTER_UI_FONTS.map((font) => [font.id, font]));

export function matterUiFontDefinition(id: MatterUiFont): MatterUiFontDefinition {
  return FONTS_BY_ID.get(id) ?? MATTER_UI_FONTS[0]!;
}

// Each bundled face is its own chunk, fetched only once that font is picked or previewed.
export const MATTER_UI_FONT_LOADERS: Partial<Record<MatterUiFont, () => Promise<unknown>>> = {
  geist: () => import("@fontsource-variable/geist/index.css"),
  "ibm-plex-sans": () =>
    Promise.all([
      import("@fontsource/ibm-plex-sans/400.css"),
      import("@fontsource/ibm-plex-sans/500.css"),
      import("@fontsource/ibm-plex-sans/600.css"),
      import("@fontsource/ibm-plex-sans/700.css"),
    ]),
  allo: () => import("@fontsource-variable/figtree/index.css"),
  "anthropic-sans": () => import("@fontsource-variable/source-sans-3/index.css"),
  "jetbrains-sans": () => import("@fontsource-variable/inter-tight/index.css"),
  "google-sans-flex": () => import("@fontsource-variable/google-sans-flex/index.css"),
  "berkeley-mono": () =>
    Promise.all([
      import("@fontsource/commit-mono/400.css"),
      import("@fontsource/commit-mono/500.css"),
      import("@fontsource/commit-mono/600.css"),
      import("@fontsource/commit-mono/700.css"),
    ]),
};

const loadedFonts = new Map<MatterUiFont, Promise<unknown>>();

export function loadMatterUiFont(id: MatterUiFont): Promise<unknown> {
  const existing = loadedFonts.get(id);
  if (existing) return existing;
  const loader = MATTER_UI_FONT_LOADERS[id];
  const pending = loader ? loader().catch(() => undefined) : Promise.resolve();
  loadedFonts.set(id, pending);
  return pending;
}

const STYLE_ELEMENT_ID = "matter-ui-font";

/**
 * A stylesheet rule rather than an inline property: appInit owns the inline `--font-sans`
 * (Typography's custom interface font) and clears it, and an explicit pick here should win.
 */
export function applyMatterUiFont(root: HTMLElement, id: MatterUiFont): void {
  const doc = root.ownerDocument;
  const existing = doc.getElementById(STYLE_ELEMENT_ID);
  if (id === DEFAULT_MATTER_UI_FONT) {
    delete root.dataset.matterUiFont;
    existing?.remove();
    return;
  }
  void loadMatterUiFont(id);
  root.dataset.matterUiFont = id;
  const style = existing ?? doc.head.appendChild(doc.createElement("style"));
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `:root { --font-sans: ${matterUiFontDefinition(id).stack} !important; }`;
}

export function readMatterUiFont(): MatterUiFont {
  return readLocalStorageValue(MATTER_UI_FONT_STORAGE_KEY, DEFAULT_MATTER_UI_FONT, MatterUiFont);
}

/** Applies the saved font before the first render and follows later changes from any window. */
export function startMatterUiFont(root: HTMLElement = document.documentElement): () => void {
  applyMatterUiFont(root, readMatterUiFont());
  return subscribeLocalStorageKey(MATTER_UI_FONT_STORAGE_KEY, () =>
    applyMatterUiFont(root, readMatterUiFont()),
  );
}

export function useMatterUiFont() {
  return useLocalStorage(MATTER_UI_FONT_STORAGE_KEY, DEFAULT_MATTER_UI_FONT, MatterUiFont);
}
