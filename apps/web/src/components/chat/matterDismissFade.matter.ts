import { useEffect, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Fades a banner or bar out before invoking `onDismiss`, skipping the delay under reduced motion.
 * Resets cleanly if `resetKey` changes while a dismiss is in flight.
 */
export function useMatterDismissFade(
  onDismiss: (() => void) | undefined,
  durationMs: number,
  resetKey?: string | null,
) {
  const [dismissing, setDismissing] = useState(false);
  const [trackedKey, setTrackedKey] = useState(resetKey);
  const fireDismiss = useStableCallback(() => {
    onDismiss?.();
  });

  if (trackedKey !== resetKey) {
    setTrackedKey(resetKey);
    if (dismissing) setDismissing(false);
  }

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- schedules and cancels the dismiss fade timer while dismissing
  useEffect(() => {
    if (!dismissing) return;
    const timer = window.setTimeout(() => {
      fireDismiss();
    }, durationMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [dismissing, durationMs, fireDismiss]);

  const triggerDismiss = () => {
    if (!onDismiss || dismissing) return;
    if (prefersReducedMotion()) {
      fireDismiss();
      return;
    }
    setDismissing(true);
  };

  return { dismissing, triggerDismiss };
}
