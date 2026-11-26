import { observeResize } from "~/lib/observeResize";

/**
 * Matter: ref for a wrapper whose height follows its only child, so the Questions and Plan
 * Overview cards ease between sizes. CSS owns the transition (`[data-matter-height]`); the
 * observer runs only when the child resizes, so an idle card costs nothing.
 */
export function matterAnimatedHeightRef(outer: HTMLElement | null) {
  const inner = outer?.firstElementChild;
  if (!outer || !(inner instanceof HTMLElement)) return;
  let frame = 0;
  const apply = () => {
    outer.style.height = `${inner.offsetHeight}px`;
  };
  apply();
  // The first size lands without a transition; later ones animate.
  frame = window.requestAnimationFrame(() => {
    outer.dataset.matterHeightReady = "";
  });
  const stopObserving = observeResize(inner, apply);
  return () => {
    window.cancelAnimationFrame(frame);
    stopObserving();
  };
}
