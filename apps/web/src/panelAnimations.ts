import { createContext, useContext, useEffect, useState } from "react";
import { type PanelAnimationDurationMs } from "@t3tools/contracts/settings";

import { useMediaQuery } from "./hooks/useMediaQuery";
import { useClientSettings } from "./hooks/useSettings";

const PanelAnimationSuppressionContext = createContext(false);

export const PanelAnimationSuppressionProvider = PanelAnimationSuppressionContext.Provider;

export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<string | null>(null);
  const suppressed = paintedNavigationKey !== navigationKey;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Wait two browser frames so the new route paints before panel animations are re-enabled; cancel the frames on change or unmount.
  useEffect(() => {
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => setPaintedNavigationKey(navigationKey));
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

// mattr: panels slide like its sidebar (antimatter/shell.css) even when the setting is 0; a
// nonzero setting still picks the speed. Tests keep upstream's off-by-default behavior.
const MATTR_PANEL_ANIMATION_DURATION_MS = import.meta.env.MODE === "test" ? 0 : 260;

export function usePanelAnimationSettings(): {
  active: boolean;
  durationMs: PanelAnimationDurationMs;
} {
  const settingMs = useClientSettings((settings) => settings.panelAnimationDurationMs);
  const durationMs = settingMs > 0 ? settingMs : MATTR_PANEL_ANIMATION_DURATION_MS;
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const suppressed = useContext(PanelAnimationSuppressionContext);
  return { active: durationMs > 0 && !prefersReducedMotion && !suppressed, durationMs };
}

export function usePanelPresence<T>(
  open: boolean,
  value: T | null,
  animated: boolean,
  scopeKey: string | null,
  durationMs: PanelAnimationDurationMs,
): { present: boolean; value: T | null } {
  const [present, setPresent] = useState(open);
  const [retained, setRetained] = useState<{ scopeKey: string | null; value: T | null } | null>(
    open ? { scopeKey, value } : null,
  );
  if (open && (retained?.scopeKey !== scopeKey || retained.value !== value)) {
    setRetained({ scopeKey, value });
  }

  if (open && !present) setPresent(true);
  if (!open && !animated && present) setPresent(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the closing panel mounted for its CSS exit transition, then unmount it; the timer is cleared on reopen or unmount.
  useEffect(() => {
    if (open || !animated) return;
    const timeout = window.setTimeout(() => setPresent(false), durationMs);
    return () => window.clearTimeout(timeout);
  }, [animated, durationMs, open]);

  const retainedValue = retained?.scopeKey === scopeKey ? retained.value : null;
  const visible = open || (animated && present && retained?.scopeKey === scopeKey);
  return { present: visible, value: open ? value : visible ? retainedValue : null };
}

// mattr: a panel that opens as it mounts spends its open transition on the mount's own work
// and paints already open. Report it open only after it has painted closed once.
export function usePanelOpenAfterPaint(open: boolean): boolean {
  const { active } = usePanelAnimationSettings();
  const [shown, setShown] = useState(open && !active);
  if (!open && shown) setShown(false);
  if (open && !active && !shown) setShown(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Wait two browser frames so the closed panel paints before its open transition starts; cancel the frames on change or unmount.
  useEffect(() => {
    if (!open || shown) return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => setShown(true));
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [open, shown]);

  return open && shown;
}
