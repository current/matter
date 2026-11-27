/** Scroll edge → Blur, mounted right after a `topbar-scroll-fade` scroller in a positioned parent.
 * One masked backdrop layer can only crossfade sharp text into blurred text, which ghosts; stacked
 * bands that each blur twice as hard as the one below give a true progressive blur. Styles and the
 * Blur-only gate live in matter/shell.css. */
export function MatterScrollEdgeBlur() {
  return (
    <div aria-hidden data-matter-edge-blur="">
      <i />
      <i />
      <i />
      <i />
    </div>
  );
}
