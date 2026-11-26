import { useLayoutEffect, useRef } from "react";

/** The hast tag ChatMarkdown maps to this component while a message streams in RareUI mode. */
export const STREAM_DOT_TAG = "mattr-stream-dot";
// oxlint-disable-next-line shadcn/no-unknown-classes -- styled by the fork stylesheet antimatter/stream-animation.css, which loads outside Tailwind.
export const STREAM_DOT_CLASS = "mattr-stream-dot";

const GLIDE_MS = 180;
const GLIDE_EASING = "cubic-bezier(0.25, 0.8, 0.3, 1)";

interface DotTrack {
  /** Untranslated position, relative to the streaming root so scrolling doesn't read as motion. */
  readonly x: number;
  readonly y: number;
  /** Where the glide started, relative to `x`. */
  readonly from: number;
  readonly glide: Animation | null;
}

// Keyed by the streaming root: the dot remounts whenever words land before it, and the next one
// glides on from wherever the last one visibly was.
const tracks = new WeakMap<Element, DotTrack>();

function glideOffset(track: DotTrack | undefined): number {
  const glide = track?.glide;
  if (!track || !glide || glide.playState !== "running") return 0;
  // Iteration progress already has the glide's easing applied.
  const progress = glide.effect?.getComputedTiming().progress;
  return typeof progress === "number" ? track.from * (1 - progress) : 0;
}

/** RareUI's caret: a dot riding the end of the live text that glides to each new word. */
export function MattrStreamDot() {
  const ref = useRef<HTMLSpanElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the laid-out dot after every render and drives its Web Animations glide; only layout says where the text ends.
  useLayoutEffect(() => {
    const dot = ref.current;
    if (!dot) return;
    const root = dot.closest("[data-mattr-stream]") ?? dot.parentElement ?? dot;
    const last = tracks.get(root);
    const origin = root.getBoundingClientRect();
    const rect = dot.getBoundingClientRect();
    const current = last?.glide && (last.glide.effect as KeyframeEffect | null)?.target === dot;
    const x = rect.left - origin.left - (current ? glideOffset(last) : 0);
    const y = rect.top - origin.top;
    if (last && last.x === x && Math.abs(last.y - y) < 0.5) return;
    const from = last ? last.x + glideOffset(last) - x : 0;
    last?.glide?.cancel();
    const sameLine = last !== undefined && Math.abs(last.y - y) <= 2;
    tracks.set(root, {
      x,
      y,
      from,
      glide:
        sameLine && from !== 0
          ? dot.animate([{ translate: `${from}px 0` }, { translate: "0 0" }], {
              duration: GLIDE_MS,
              easing: GLIDE_EASING,
            })
          : null,
    });
  });

  return <span ref={ref} aria-hidden className={STREAM_DOT_CLASS} />;
}
