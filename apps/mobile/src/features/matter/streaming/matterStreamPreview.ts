// Arrivals as a provider sends them: mostly a word or two, with a stall and a burst, so Smooth
// Pace and Phrase have something to even out. About two seconds in all.
const ARRIVAL_WORDS = [1, 2, 1, 1, 3, 1, 2, 6, 1, 2, 1, 1, 2, 5, 1, 1];
const ARRIVAL_DELAYS_MS = [90, 110, 80, 100, 120, 90, 420, 100, 90, 110, 80, 100, 300, 90, 100, 90];
/** The turn ends a moment after its last words, as a provider's does. */
export const PREVIEW_TURN_END_DELAY_MS = 600;

export interface PreviewArrival {
  /** Milliseconds after the preview starts. */
  readonly at: number;
  /** Characters of the sample shown by then. */
  readonly length: number;
}

/** When each chunk of `text` arrives, ending with the whole sample. */
export function matterStreamPreviewArrivals(text: string): PreviewArrival[] {
  const tokens = text.match(/\s+|\S+/g) ?? [];
  const arrivals: PreviewArrival[] = [];
  let length = 0;
  let index = 0;
  let at = 0;
  ARRIVAL_WORDS.forEach((words, step) => {
    if (index >= tokens.length) return;
    for (let taken = 0; taken < words && index < tokens.length; index++) {
      length += tokens[index]!.length;
      if (!/^\s/.test(tokens[index]!)) taken++;
    }
    at += ARRIVAL_DELAYS_MS[step] ?? 90;
    arrivals.push({ at, length });
  });
  if (length < text.length) arrivals.push({ at: at + 90, length: text.length });
  return arrivals;
}
