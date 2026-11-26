/** mattr: keys that fill the predicted next message into an empty composer. */
const PREDICTION_ACCEPT_KEYS: ReadonlySet<string> = new Set(["Tab", "ArrowRight"]);

export function isPredictionAcceptKey(key: string): boolean {
  return PREDICTION_ACCEPT_KEYS.has(key);
}

/** Whether the ghost text overflows its clamp; a pixel of slack absorbs sub-pixel line heights. */
export function isPredictionClamped(box: {
  readonly scrollHeight: number;
  readonly clientHeight: number;
}): boolean {
  return box.scrollHeight > box.clientHeight + 1;
}
