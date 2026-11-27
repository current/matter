import { useSyncExternalStore } from "react";

import { writeFileAtomically } from "../../../lib/atomic-file";

const FOLDS_FILE_NAME = "matter-timeline-folds.json";

type Folds = Readonly<Record<string, boolean>>;

let folds: Folds = {};
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function parseMatterTimelineFolds(raw: string | null): Folds {
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, boolean] => {
        return typeof entry[1] === "boolean";
      }),
    );
  } catch {
    return {};
  }
}

async function foldsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, FOLDS_FILE_NAME);
}

function load() {
  loading ??= foldsFile()
    .then(async (file) => (file.exists ? parseMatterTimelineFolds(await file.text()) : {}))
    .catch((): Folds => ({}))
    .then((stored) => {
      // A toggle made before the file arrived wins over the stored value.
      folds = { ...stored, ...folds };
      loaded = true;
      emit();
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

const getFolds = () => folds;
const getLoaded = () => loaded;

/** Sets one section's fold on this device; the Timeline's other sections keep theirs. */
export function setMatterTimelineFold(sectionId: string, open: boolean) {
  folds = { ...folds, [sectionId]: open };
  emit();
  const snapshot = JSON.stringify(folds);
  void foldsFile()
    .then((file) => writeFileAtomically(file, snapshot))
    .catch(() => undefined);
}

/** The Timeline's saved folds, per device (desktop keeps its own in `localStorage`). */
export function useMatterTimelineFolds() {
  const current = useSyncExternalStore(subscribe, getFolds, getFolds);
  const isLoaded = useSyncExternalStore(subscribe, getLoaded, getLoaded);
  return { folds: current, loaded: isLoaded } as const;
}
