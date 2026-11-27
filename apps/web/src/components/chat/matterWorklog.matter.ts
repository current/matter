import { useEffect, useState, type CSSProperties } from "react";

// Matter "Tighter" work log motion; upstream tests keep upstream's instant disclosures.
const MOTION = import.meta.env.MODE !== "test";
const CLOSE_MS = 120;
const CASCADE_WINDOW_MS = 400;
const CASCADE_MAX_ROWS = 8;
const CASCADE_STEP_MS = 24;

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

type DisclosurePhase = "opening" | "closing" | null;

/**
 * Keeps details mounted through their 120 ms exit, and marks them opening only when this mount
 * opened them, so a virtualized row that remounts already open doesn't replay its entrance.
 * `phase` feeds `data-matter-disclosure`; matter/chat-worklog.css owns the motion.
 */
export function useMatterDisclosure(open: boolean): {
  readonly present: boolean;
  readonly phase: DisclosurePhase;
} {
  const [state, setState] = useState<{ open: boolean; phase: DisclosurePhase }>({
    open,
    phase: null,
  });
  if (state.open !== open) {
    setState({
      open,
      phase: !MOTION ? null : open ? "opening" : reducedMotion() ? null : "closing",
    });
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- unmounts closing details once their exit animation's time has passed.
  useEffect(() => {
    if (state.phase !== "closing") return;
    const timer = setTimeout(
      () => setState((s) => (s.phase === "closing" ? { ...s, phase: null } : s)),
      CLOSE_MS,
    );
    return () => clearTimeout(timer);
  }, [state.phase]);
  return { present: open || state.phase === "closing", phase: state.phase };
}

let workGroupOpenedAt = Number.NEGATIVE_INFINITY;

/** Called by every control that toggles a work group, before it toggles. */
export function noteWorkGroupToggle(wasExpanded: boolean) {
  if (!wasExpanded) workGroupOpenedAt = performance.now();
}

/**
 * Whether a work group's rows should cascade in: only for a group the user just opened, and only
 * for its first moments, so rows scrolled into view later (or recycled) appear still.
 */
export function useWorkGroupCascade(): boolean {
  const [cascade, setCascade] = useState(
    () => MOTION && !reducedMotion() && performance.now() - workGroupOpenedAt < CASCADE_WINDOW_MS,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the cascade ends with wall-clock time, after its last row has landed.
  useEffect(() => {
    if (!cascade) return;
    const timer = setTimeout(
      () => setCascade(false),
      CASCADE_MAX_ROWS * CASCADE_STEP_MS + CASCADE_WINDOW_MS,
    );
    return () => clearTimeout(timer);
  }, [cascade]);
  return cascade;
}

/** Inline style for a cascading row at `index`; rows past the first few land together. */
export function workGroupCascadeStyle(index: number) {
  return {
    "--matter-cascade-delay": `${Math.min(index, CASCADE_MAX_ROWS - 1) * CASCADE_STEP_MS}ms`,
  } as CSSProperties;
}
