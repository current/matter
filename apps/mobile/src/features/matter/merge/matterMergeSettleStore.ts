import {
  addMergeSettleDismissal,
  MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY,
  type MergeSettleDismissals,
  parseMergeSettleDismissals,
} from "@t3tools/client-runtime/matter/merge-settle-prompt";
import { useSyncExternalStore } from "react";

import { writeFileAtomically } from "../../../lib/atomic-file";

// The web key with its separators made file-safe; the file holds the same JSON web keeps in localStorage.
const DISMISSALS_FILE_NAME = `${MATTER_MERGE_SETTLE_PROMPT_STORAGE_KEY.replaceAll(":", "-")}.json`;

let dismissals: MergeSettleDismissals = [];
let loaded = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

async function dismissalsFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, DISMISSALS_FILE_NAME);
}

function load(): void {
  loading ??= dismissalsFile()
    .then(async (file) => (file.exists ? parseMergeSettleDismissals(await file.text()) : []))
    .catch((): MergeSettleDismissals => [])
    .then((stored) => {
      // Answers given before the file arrived win over the stored ones.
      dismissals = dismissals.reduce(
        (next, [threadKey, prNumber]) => addMergeSettleDismissal(next, threadKey, prNumber),
        stored,
      );
      loaded = true;
      emit();
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

const getDismissals = () => dismissals;
const getLoaded = () => loaded;

/** Remembers Keep for this thread and pull request on this device. */
export function dismissMatterMergeSettlePrompt(threadKey: string, prNumber: number) {
  dismissals = addMergeSettleDismissal(dismissals, threadKey, prNumber);
  emit();
  load();
  // Written once the saved answers are merged in, so an early Keep never overwrites them.
  void loading
    ?.then(dismissalsFile)
    .then((file) => writeFileAtomically(file, JSON.stringify(dismissals)))
    .catch(() => undefined);
}

/** Kept answers, per device; `loaded` stays false until the saved ones are read. */
export function useMatterMergeSettleDismissals() {
  const current = useSyncExternalStore(subscribe, getDismissals, getDismissals);
  const isLoaded = useSyncExternalStore(subscribe, getLoaded, getLoaded);
  return { dismissals: current, loaded: isLoaded } as const;
}
