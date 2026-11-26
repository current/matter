import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { CheckIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useGT, useMessages } from "gt-react";
import * as Schema from "effect/Schema";

import { MattrAiStatus } from "../chat/MattrAiStatusIndicator";
import {
  DEFAULT_MATTR_AI_STATUS_STYLE,
  MATTR_AI_STATUS_PHASES,
  MATTR_AI_STATUS_STYLES,
  MattrAiStatusStyle,
  type MattrAiStatusPhase,
  useMattrAiStatusStyle,
} from "../../mattrAiStatus";
import { Button } from "../ui/button";
import { RadioGroup } from "../ui/radio-group";
import { SettingResetButton, SettingsRow } from "./settingsLayout";

const isMattrAiStatusStyle = Schema.is(MattrAiStatusStyle);

/** One sample turn, about nine seconds: it ends finished, so nothing loops in Settings. */
export const AI_STATUS_PREVIEW_STEPS: ReadonlyArray<{
  readonly phase: MattrAiStatusPhase;
  readonly ms: number;
}> = [
  { phase: "thinking", ms: 1800 },
  { phase: "searching", ms: 1800 },
  { phase: "editing", ms: 1800 },
  { phase: "running", ms: 1600 },
  { phase: "writing", ms: 2000 },
];

/** Plays the sample turn once on mount; the parent remounts it to replay. */
function AiStatusPreview({ style }: { readonly style: MattrAiStatusStyle }) {
  const gt = useGT();
  const m = useMessages();
  const [step, setStep] = useState(0);
  const [seconds, setSeconds] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- replays a timed sample turn; the timers end with it.
  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let at = 0;
    AI_STATUS_PREVIEW_STEPS.forEach(({ ms }, index) => {
      at += ms;
      timers.push(setTimeout(() => setStep(index + 1), at));
    });
    const ticks = setInterval(() => setSeconds((count) => count + 1), 1000);
    timers.push(setTimeout(() => clearInterval(ticks), at));
    return () => {
      timers.forEach(clearTimeout);
      clearInterval(ticks);
    };
  }, []);

  const current = AI_STATUS_PREVIEW_STEPS[step];
  const time = gt("{seconds}s", { seconds });
  if (style === "default") {
    const label = current ? gt("Working for {time}", { time }) : gt("Worked for {time}", { time });
    return (
      <span
        data-mattr-ai-status-preview="default"
        className="flex h-6 w-fit items-center whitespace-nowrap px-1 text-sm leading-relaxed text-muted-foreground tabular-nums"
      >
        {label}
      </span>
    );
  }
  if (!current) {
    return <MattrAiStatus icon="done" label={gt("Worked for {time}", { time })} active={false} />;
  }
  const config = MATTR_AI_STATUS_PHASES[current.phase];
  return (
    <MattrAiStatus icon={config.icon} label={m(config.label)} active={config.active} timer={time} />
  );
}

/** Settings → Appearance: how the live working row shows what the agent is doing, per device. */
export function MattrAiStatusSetting() {
  const gt = useGT();
  const m = useMessages();
  const [style, setStyle] = useMattrAiStatusStyle();
  const [replay, setReplay] = useState(0);

  return (
    <SettingsRow
      id="mattr-ai-status"
      title={gt("AI status")}
      description={gt(
        "How the status above a running reply shows what the agent is doing. It disappears when the turn ends.",
      )}
      devicePreference
      resetAction={
        style !== DEFAULT_MATTR_AI_STATUS_STYLE ? (
          <SettingResetButton
            ariaLabel={gt("Reset AI status to default")}
            onClick={() => setStyle(DEFAULT_MATTR_AI_STATUS_STYLE)}
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-3 pt-3 pb-2">
        <div className="flex min-w-0 items-center gap-3 rounded-lg bg-card px-3.5 py-3 ring-1 ring-black/5 dark:bg-white/3 dark:ring-white/5">
          <div className="min-w-0 flex-1">
            <AiStatusPreview key={`${style}:${replay}`} style={style} />
          </div>
          <Button
            variant="ghost-muted"
            size="icon-xs"
            className="-me-1 shrink-0"
            aria-label={gt("Replay preview")}
            onClick={() => setReplay((count) => count + 1)}
          >
            <RotateCcwIcon />
          </Button>
        </div>
        <RadioGroup
          aria-label={gt("AI status")}
          value={style}
          onValueChange={(value) => {
            if (isMattrAiStatusStyle(value)) setStyle(value);
          }}
          className="grid grid-cols-1 @min-[32rem]/settings-row:grid-cols-2"
        >
          {MATTR_AI_STATUS_STYLES.map((definition) => (
            <RadioPrimitive.Root
              key={definition.id}
              value={definition.id}
              data-mattr-ai-status-option={definition.id}
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
