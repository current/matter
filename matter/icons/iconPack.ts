// The app-wide icon pack. React-free on purpose: the generated lucide-react stand-in and the web
// app both import this module, and "react" doesn't resolve from outside apps/web.

export const ICON_PACKS = [
  "sf-symbols-fill",
  "solar-bold",
  "solar-duotone",
  "phosphor-fill",
  "heroicons-solid",
  "remix-fill",
  "mingcute-fill",
  "fluent-filled",
  "ionicons-solid",
  "material-rounded-fill",
  "tabler-filled",
  "hugeicons",
  "lucide-orca",
] as const;
export type IconPackId = (typeof ICON_PACKS)[number];
/** Packs drawn from a lazily loaded chunk of SVG bodies; SF Symbols and lucide ship with the app. */
export type IconPackSource = Exclude<IconPackId, "sf-symbols-fill" | "lucide-orca">;

export const ICON_PACK_OPTIONS: ReadonlyArray<{
  readonly id: IconPackId;
  readonly label: string;
  readonly shortLabel: string;
}> = [
  { id: "sf-symbols-fill", label: "SF Symbols Fill", shortLabel: "SF Fill" },
  { id: "solar-bold", label: "Solar Bold · Clonk", shortLabel: "Solar" },
  { id: "solar-duotone", label: "Solar Duotone", shortLabel: "Duotone" },
  { id: "phosphor-fill", label: "Phosphor Fill", shortLabel: "Phosphor" },
  { id: "heroicons-solid", label: "Heroicons Solid", shortLabel: "Hero" },
  { id: "remix-fill", label: "Remix Fill", shortLabel: "Remix" },
  { id: "mingcute-fill", label: "MingCute Fill", shortLabel: "MingCute" },
  { id: "fluent-filled", label: "Fluent Filled", shortLabel: "Fluent" },
  { id: "ionicons-solid", label: "Ionicons", shortLabel: "Ionicons" },
  { id: "material-rounded-fill", label: "Material Rounded", shortLabel: "Material" },
  { id: "tabler-filled", label: "Tabler Filled", shortLabel: "Tabler" },
  { id: "hugeicons", label: "Hugeicons · Synara", shortLabel: "Synara" },
  { id: "lucide-orca", label: "Lucide · Orca", shortLabel: "Orca" },
];

export const DEFAULT_ICON_PACK: IconPackId = "sf-symbols-fill";
const STORAGE_KEY = "mattr:icon-pack:v1";

/** lucide name → [svg body, viewBox] */
export type IconGlyphMap = Readonly<Record<string, readonly [string, string]>>;

export interface IconPackState {
  /** The pack the user picked. */
  readonly requested: IconPackId;
  /** The pack icons draw now: the requested one once its chunk has loaded, else the last one shown. */
  readonly shown: IconPackId | null;
  readonly sources: Readonly<Partial<Record<IconPackSource, IconGlyphMap>>>;
  readonly failed: Readonly<Partial<Record<IconPackSource, true>>>;
}

export const iconPackSource = (pack: IconPackId): IconPackSource | null =>
  pack === "sf-symbols-fill" || pack === "lucide-orca" ? null : pack;

export const isIconPackId = (value: unknown): value is IconPackId =>
  typeof value === "string" && (ICON_PACKS as ReadonlyArray<string>).includes(value);

function readStoredPack(): IconPackId {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isIconPackId(value) ? value : DEFAULT_ICON_PACK;
  } catch {
    return DEFAULT_ICON_PACK;
  }
}

const initialPack = readStoredPack();
let state: IconPackState = {
  requested: initialPack,
  shown: iconPackSource(initialPack) === null ? initialPack : null,
  sources: {},
  failed: {},
};
const listeners = new Set<() => void>();
let loaders: Partial<Record<IconPackSource, () => Promise<{ icons: IconGlyphMap }>>> = {};
const pending = new Set<IconPackSource>();

function setState(next: IconPackState) {
  state = next;
  for (const listener of listeners) listener();
}

function settle() {
  const source = iconPackSource(state.requested);
  const ready = source === null || state.sources[source] !== undefined || state.failed[source];
  if (ready && state.shown !== state.requested) setState({ ...state, shown: state.requested });
}

function load(source: IconPackSource) {
  const loader = loaders[source];
  if (!loader || pending.has(source) || state.sources[source] || state.failed[source]) return;
  pending.add(source);
  loader().then(
    (module) => {
      pending.delete(source);
      setState({ ...state, sources: { ...state.sources, [source]: module.icons } });
      settle();
    },
    (error: unknown) => {
      pending.delete(source);
      console.warn(`[Matter] ${source} icons failed to load, drawing lucide:`, error);
      setState({ ...state, failed: { ...state.failed, [source]: true } });
      settle();
    },
  );
}

function request(pack: IconPackId) {
  if (pack !== state.requested) setState({ ...state, requested: pack });
  const source = iconPackSource(pack);
  if (source !== null) load(source);
  settle();
}

export const getIconPackState = (): IconPackState => state;
export const getIconPack = (): IconPackId => state.requested;

export function subscribeIconPack(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setIconPack(pack: IconPackId): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, pack);
  } catch {}
  request(pack);
}

/** Loads every pack chunk, for previews that draw packs other than the one on screen. */
export function preloadIconPacks(): void {
  for (const source of Object.keys(loaders) as IconPackSource[]) load(source);
}

/** Called by the generated lucide-react stand-in, which owns the lazy pack chunks. */
export function registerIconPackLoaders(next: typeof loaders): void {
  loaders = { ...loaders, ...next };
  request(state.requested);
}

// Other windows (Island, a second app window) follow a change made in this one.
globalThis.addEventListener?.("storage", (event: StorageEvent) => {
  if (event.key === STORAGE_KEY)
    request(isIconPackId(event.newValue) ? event.newValue : DEFAULT_ICON_PACK);
});
