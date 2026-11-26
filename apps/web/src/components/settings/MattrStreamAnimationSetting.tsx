import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useGT, useMessages } from "gt-react";
import * as Schema from "effect/Schema";

import { MattrStreamDot } from "../chat/MattrStreamDot";
import { STREAM_CARET_CLASS, STREAM_WORD_CLASS } from "../chat/mattrStreamHast";
import {
  DEFAULT_MATTR_STREAM_ANIMATION,
  MATTR_STREAM_ANIMATIONS,
  MattrStreamAnimation,
  useBurstPacedText,
  usePacedText,
  useMattrStreamAnimationSetting,
  wholeWordEnds,
} from "../../mattrStreamAnimation";
import { Button } from "../ui/button";
import { RadioGroup } from "../ui/radio-group";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const isMattrStreamAnimation = Schema.is(MattrStreamAnimation);

const PREVIEW_TOKEN_PATTERN = /`[^`]*`|\s+|[^\s`]+/g;

/** Words, spaces and `code` of `text`, the way the chat splits a streaming paragraph. */
function previewTokens(text: string): string[] {
  return text.match(PREVIEW_TOKEN_PATTERN) ?? [];
}

// Arrivals as a provider sends them: mostly a word or two, with a stall and a burst, so Smooth
// Pace has something to even out. About two seconds in all.
const ARRIVAL_WORDS = [1, 2, 1, 1, 3, 1, 2, 6, 1, 2, 1, 1, 2, 5, 1, 1];
const ARRIVAL_DELAYS_MS = [90, 110, 80, 100, 120, 90, 420, 100, 90, 110, 80, 100, 300, 90, 100, 90];
/** The turn ends a moment after its last words, as a provider's does. */
const TURN_END_DELAY_MS = 600;

/** Character counts after each arrival, ending at the whole sample. */
export function previewArrivals(text: string): number[] {
  const tokens = previewTokens(text);
  const counts: number[] = [];
  let length = 0;
  let index = 0;
  for (const words of ARRIVAL_WORDS) {
    for (let taken = 0; taken < words && index < tokens.length; index++) {
      length += tokens[index]!.length;
      if (!/^\s/.test(tokens[index]!)) taken++;
    }
    counts.push(length);
  }
  if (length < text.length) counts.push(text.length);
  return counts;
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const subscribeReducedMotion = (onChange: () => void) => {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const readReducedMotion = () => window.matchMedia(REDUCED_MOTION_QUERY).matches;

/** Plays the sample once on mount; the parent remounts it to replay. */
function StreamPreview({
  animation,
  sample,
  reducedMotion,
}: {
  readonly animation: MattrStreamAnimation;
  readonly sample: string;
  readonly reducedMotion: boolean;
}) {
  const [arrived, setArrived] = useState(reducedMotion ? sample.length : 0);
  const [arrivalsDone, setArrivalsDone] = useState(reducedMotion);
  const [streaming, setStreaming] = useState(!reducedMotion);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replays a timed sample stream; the timers end with the sample.
  useEffect(() => {
    if (reducedMotion) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    previewArrivals(sample).forEach((length, index) => {
      at += ARRIVAL_DELAYS_MS[index] ?? 90;
      timers.push(setTimeout(() => setArrived(length), at));
    });
    timers.push(setTimeout(() => setArrivalsDone(true), at));
    return () => timers.forEach(clearTimeout);
  }, [sample, reducedMotion]);

  const paced = usePacedText(sample.slice(0, arrived), streaming && animation === "typewriter");
  const visible = useBurstPacedText(paced, streaming && animation === "rareui");
  // RareUI's bursts can trail the sample, so its turn ends once they have caught up.
  const caughtUp = animation !== "rareui" || visible.length >= (wholeWordEnds(sample).at(-1) ?? 0);
  const turnEnding = streaming && arrivalsDone && caughtUp;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the sample turn ends on a timer, a moment after its last words, as a provider's does.
  useEffect(() => {
    if (!turnEnding) return;
    const timer = setTimeout(() => setStreaming(false), TURN_END_DELAY_MS);
    return () => clearTimeout(timer);
  }, [turnEnding]);

  // Like the chat: word spans only while streaming, then the same text renders plain.
  const live = streaming && animation !== "instant";
  const caret = live && (animation === "blur" || animation === "typewriter");

  return (
    <div className="chat-markdown grid min-w-0 text-sm leading-relaxed text-foreground">
      <p aria-hidden className="invisible col-start-1 row-start-1 m-0">
        {renderTokens(sample, false)}
      </p>
      <p className="col-start-1 row-start-1 m-0" data-mattr-stream={live ? animation : undefined}>
        {renderTokens(visible, live)}
        {caret ? <span aria-hidden className={STREAM_CARET_CLASS} /> : null}
        {live && animation === "rareui" ? <MattrStreamDot /> : null}
      </p>
    </div>
  );
}

function renderTokens(text: string, live: boolean) {
  return previewTokens(text).map((token, index) => {
    if (token.startsWith("`")) {
      return (
        // oxlint-disable-next-line react/no-array-index-key -- tokens only append, so an index is a stable identity.
        <code key={index} className={live ? STREAM_WORD_CLASS : undefined}>
          {token.slice(1, -1)}
        </code>
      );
    }
    if (!live || /^\s/.test(token)) return token;
    return (
      // oxlint-disable-next-line react/no-array-index-key -- tokens only append, so an index is a stable identity.
      <span key={index} className={STREAM_WORD_CLASS}>
        {token}
      </span>
    );
  });
}

/** Settings → Appearance: how assistant text arrives while it streams, saved on this device. */
export function MattrStreamAnimationSetting() {
  const gt = useGT();
  const m = useMessages();
  const [animation, setAnimation] = useMattrStreamAnimationSetting();
  const [replay, setReplay] = useState(0);
  const reducedMotion = useSyncExternalStore(
    subscribeReducedMotion,
    readReducedMotion,
    () => false,
  );
  const sample = gt(
    "Moved the session store behind `reconnect()`, so a dropped socket resumes mid-turn and every streamed word lands exactly once.",
  );

  return (
    <SettingsRow
      id="mattr-stream-animation"
      title={gt("Streaming text")}
      description={gt(
        "How new words appear while an assistant replies. Finished messages always render plain. Reduced motion shows text instantly.",
      )}
      devicePreference
      resetAction={
        animation !== DEFAULT_MATTR_STREAM_ANIMATION ? (
          <SettingResetButton
            ariaLabel={gt("Reset streaming text to default")}
            onClick={() => setAnimation(DEFAULT_MATTR_STREAM_ANIMATION)}
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-3 pt-3 pb-2">
        <div className="flex min-w-0 items-start gap-3 rounded-lg bg-card px-3.5 py-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
          <div className="min-w-0 flex-1">
            <StreamPreview
              key={`${animation}:${replay}:${reducedMotion}`}
              animation={animation}
              sample={sample}
              reducedMotion={reducedMotion}
            />
          </div>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            className="-me-1 -mt-0.5 shrink-0"
            aria-label={gt("Replay preview")}
            onClick={() => setReplay((count) => count + 1)}
          >
            <RotateCcwIcon />
          </Button>
        </div>
        <RadioGroup
          aria-label={gt("Streaming text")}
          value={animation}
          onValueChange={(value) => {
            if (isMattrStreamAnimation(value)) setAnimation(value);
          }}
          className="grid grid-cols-1 @min-[32rem]/settings-row:grid-cols-2 @min-[48rem]/settings-row:grid-cols-3"
        >
          {MATTR_STREAM_ANIMATIONS.map((definition) => (
            <RadioPrimitive.Root
              key={definition.id}
              value={definition.id}
              data-mattr-stream-option={definition.id}
              className="flex min-w-0 cursor-pointer items-start gap-2 rounded-lg bg-card px-3 py-2.5 text-left outline-none ring-1 ring-black/5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-checked:bg-primary/8 data-checked:ring-2 data-checked:ring-inset data-checked:ring-primary data-checked:hover:bg-primary/8 dark:bg-white/3 dark:ring-white/5 dark:hover:bg-white/5 dark:data-checked:bg-primary/15 dark:data-checked:ring-primary dark:data-checked:hover:bg-primary/15"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-foreground">
                  {m(definition.name)}
                </span>
                <span className="line-clamp-2 text-2xs text-muted-foreground">
                  {m(definition.description)}
                </span>
              </span>
              <RadioPrimitive.Indicator
                className="grid size-4 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground"
                aria-hidden
              >
                <CheckIcon className="size-3 shrink-0" />
              </RadioPrimitive.Indicator>
            </RadioPrimitive.Root>
          ))}
        </RadioGroup>
      </div>
    </SettingsRow>
  );
}
