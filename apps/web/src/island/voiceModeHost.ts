import { useEffect, useState, useSyncExternalStore } from "react";

import { useVoiceAssistantSelector } from "./voiceAssistantStore";

interface VoiceModeHost {
  readonly id: symbol;
  readonly threadKey: string | null;
}

let hosts: ReadonlyArray<VoiceModeHost> = [];
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getHosts = () => hosts;

function setHosts(next: ReadonlyArray<VoiceModeHost>) {
  hosts = next;
  for (const listener of listeners) listener();
}

export function voiceModeThreadKey(environmentId: string, threadId: string) {
  return `${environmentId}:${threadId}`;
}

/** The composer showing the scoped thread hosts Voice Mode; otherwise the first one on screen. */
export function electVoiceModeHost(
  candidates: ReadonlyArray<VoiceModeHost>,
  scopedThreadKey: string | null,
): symbol | null {
  return (
    candidates.find((host) => scopedThreadKey !== null && host.threadKey === scopedThreadKey)?.id ??
    candidates[0]?.id ??
    null
  );
}

function useScopedThreadKey() {
  return useVoiceAssistantSelector(({ scopedThread }) =>
    scopedThread ? voiceModeThreadKey(scopedThread.environmentId, scopedThread.threadId) : null,
  );
}

/** Registers an on-screen composer that can show the Voice Mode bar; true while it should. */
export function useIsVoiceModeHost(threadKey: string | null, enabled: boolean): boolean {
  const sessionOpen = useVoiceAssistantSelector((state) => state.sessionOpen);
  const [id] = useState(() => Symbol("voice-mode-host"));
  const registered = useSyncExternalStore(subscribe, getHosts, getHosts);
  const scopedThreadKey = useScopedThreadKey();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this composer in the module-level Voice Mode host list
  useEffect(() => {
    if (!enabled) return;
    setHosts([...hosts, { id, threadKey }]);
    return () => setHosts(hosts.filter((host) => host.id !== id));
  }, [enabled, id, threadKey]);

  return sessionOpen && enabled && electVoiceModeHost(registered, scopedThreadKey) === id;
}

/** True while some composer on screen can show the Voice Mode bar. */
export function useHasVoiceModeHost(): boolean {
  return useSyncExternalStore(subscribe, getHosts, getHosts).length > 0;
}
