import { useSyncExternalStore } from "react";
import {
  DEFAULT_MATTER_STREAM_ANIMATION,
  MATTER_STREAM_ANIMATION_STORAGE_KEY,
  parseMatterNativeStreamAnimation,
  type MatterNativeStreamAnimationId,
} from "@t3tools/client-runtime/matter/stream-animation";

import { writeFileAtomically } from "../../../lib/atomic-file";

// Its own file, keyed like the web's localStorage entry, so this device keeps its choice
// without a field in upstream's preferences schema.
const FILE_NAME = "matter-stream-animation.json";

let animation: MatterNativeStreamAnimationId = parseMatterNativeStreamAnimation(
  DEFAULT_MATTER_STREAM_ANIMATION,
);
let changedBeforeLoad = false;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function parseStoredMatterStreamAnimation(
  raw: string | null,
): MatterNativeStreamAnimationId {
  if (raw === null) return "instant";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") return "instant";
    return parseMatterNativeStreamAnimation(
      (parsed as Record<string, unknown>)[MATTER_STREAM_ANIMATION_STORAGE_KEY],
    );
  } catch {
    return "instant";
  }
}

async function storeFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, FILE_NAME);
}

function load() {
  loading ??= storeFile()
    .then(async (file) =>
      file.exists ? parseStoredMatterStreamAnimation(await file.text()) : null,
    )
    .catch(() => null)
    .then((stored) => {
      if (stored === null || changedBeforeLoad || stored === animation) return;
      animation = stored;
      emit();
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

const getAnimation = () => animation;

export function setMatterStreamAnimation(next: MatterNativeStreamAnimationId) {
  changedBeforeLoad = true;
  if (next === animation) return;
  animation = next;
  emit();
  const snapshot = JSON.stringify({ [MATTER_STREAM_ANIMATION_STORAGE_KEY]: next });
  void storeFile()
    .then((file) => writeFileAtomically(file, snapshot))
    .catch(() => undefined);
}

const subscribeNothing = () => () => {};
const readInstant = (): MatterNativeStreamAnimationId => "instant";

/** This device's Streaming text style; `observe` false reads Instant and subscribes to nothing. */
export function useMatterStreamAnimationSetting(observe = true): MatterNativeStreamAnimationId {
  return useSyncExternalStore(
    observe ? subscribe : subscribeNothing,
    observe ? getAnimation : readInstant,
    readInstant,
  );
}
