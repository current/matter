import { useEffect, useRef, useState } from "react";
import {
  lastWholeWordEnd,
  PHRASE_HOLD_MS,
  stepPhrasePacer,
} from "@t3tools/client-runtime/matter/stream-animation";

/**
 * The prefix of `text` Phrase shows: whole phrases released on timers (one per phrase, never per
 * frame), plus a held clause once no text has arrived for a moment. Starts at what already
 * arrived, so a reply already streaming when it mounts doesn't replay; returns the full text the
 * moment pacing stops.
 */
export function usePhrasePacedText(text: string, pacing: boolean): string {
  const [shown, setShown] = useState(() => (pacing ? lastWholeWordEnd(text) : text.length));
  const [wasPacing, setWasPacing] = useState(pacing);
  if (pacing !== wasPacing) {
    setWasPacing(pacing);
    setShown(pacing ? lastWholeWordEnd(text) : text.length);
  }
  const pacer = useRef<{ shown: number; wait: number; at: number } | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paces against timers, an external clock; they stop once every finished phrase shows.
  useEffect(() => {
    if (!pacing) {
      pacer.current = null;
      return;
    }
    const state = pacer.current ?? {
      shown: lastWholeWordEnd(text),
      wait: 0,
      at: performance.now(),
    };
    pacer.current = state;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Shown text never shrinks: a held clause that was flushed stays up while the next one lands.
    const showUpTo = (end: number) => {
      state.shown = Math.max(state.shown, end);
      setShown((current) => Math.max(current, end));
    };
    const step = () => {
      const now = performance.now();
      // Time since the last step counts, idle time included, so a wait already served doesn't
      // hold back text that arrives after it.
      const next = stepPhrasePacer(text, state.shown, state.wait, now - state.at);
      state.wait = next.wait;
      state.at = now;
      showUpTo(next.shown);
      if (next.nextInMs !== null) {
        timer = setTimeout(step, next.nextInMs);
        return;
      }
      const lastWord = lastWholeWordEnd(text);
      if (lastWord > state.shown) timer = setTimeout(() => showUpTo(lastWord), PHRASE_HOLD_MS);
    };
    step();
    return () => clearTimeout(timer);
  }, [pacing, text]);

  if (!pacing) return text;
  return shown >= text.length ? text : text.slice(0, shown);
}
