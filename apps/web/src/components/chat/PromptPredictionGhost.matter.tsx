import { useGT } from "gt-react";
import { useLayoutEffect, useRef, useState } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { Kbd } from "../ui/kbd";
import { isPredictionClamped } from "./promptPrediction.mattr";

/**
 * mattr: the predicted next message as composer ghost text, clamped to three lines. The accept
 * chip follows the last word; once the text is clamped it floats to the end of the third line,
 * after the ellipsis, so it never drops out of view or grows the composer.
 */
export function PromptPredictionGhost(props: {
  readonly text: string;
  readonly onAccept: () => void;
}) {
  // A new prediction remounts, so the clamp is measured afresh for its text.
  return <PredictionGhostText key={props.text} text={props.text} onAccept={props.onAccept} />;
}

function PredictionGhostText(props: { readonly text: string; readonly onAccept: () => void }) {
  const gt = useGT();
  const hasFinePointer = useMediaQuery("(any-pointer: fine)");
  const textRef = useRef<HTMLSpanElement>(null);
  const [clamped, setClamped] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the rendered line count, which only layout knows.
  useLayoutEffect(() => {
    const node = textRef.current;
    if (node === null) return;
    const measure = () => setClamped(isPredictionClamped(node));
    measure();
    return observeResize(node, measure);
  }, []);

  const chip = (
    // The placeholder ignores pointer events so clicks reach the editor; only this chip opts back in.
    <button
      type="button"
      tabIndex={-1}
      aria-label={gt("Use suggested prompt")}
      data-mattr-prediction-chip=""
      className={cn(
        "pointer-events-auto relative inline-flex cursor-pointer rounded align-[1px] [&:hover_kbd]:text-foreground",
        // A larger invisible hit area for touch, without moving the chip.
        "before:absolute before:-inset-1.5 before:content-['']",
        clamped ? "float-right clear-both ml-1.5" : "ml-2",
      )}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onAccept}
    >
      <Kbd variant="outline">
        {hasFinePointer
          ? "⇥ Tab"
          : gt("Use", { $context: "button, fills the suggested message into the composer" })}
      </Kbd>
    </button>
  );

  return (
    <span className="flex min-w-0">
      <span
        ref={textRef}
        data-mattr-prediction-ghost=""
        className="line-clamp-3 min-w-0 [overflow-wrap:anywhere]"
      >
        {clamped ? <span aria-hidden className="float-right h-[calc(100%-1lh)]" /> : null}
        {clamped ? chip : null}
        {props.text}
        {clamped ? null : chip}
      </span>
    </span>
  );
}
