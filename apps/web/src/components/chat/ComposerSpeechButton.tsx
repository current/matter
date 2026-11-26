import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";
import { speechModelDownloadPercent } from "@t3tools/shared/speech";
import { msg, useGT, useMessages } from "gt-react";
import { CheckIcon, XIcon } from "lucide-react";
import { useEffect, useState, type PointerEvent, type ReactElement } from "react";

import { MatterDictateIcon } from "./MatterComposerParts.matter";

import { VoiceInputErrorPill } from "./VoiceInputErrorPill";
import { VoiceInputPill, VoiceWaveform } from "./VoiceInputPill";
import { useClientSettings } from "~/hooks/useSettings";
import { m, type MessageResolver } from "~/i18n/messages";
import { cn } from "~/lib/utils";
import { shouldFinishDictationOnRelease } from "~/speech/useDictationShortcut";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { SharedTooltipTrigger } from "../ui/shared-tooltip";

type DownloadProgress = { downloaded: number; total: number } | null;

const keepFocus = (event: PointerEvent) => event.preventDefault();

/** One short status line per phase; also mirrored into the preview annotation editor. */
export function resolveSpeechPresentation(
  state: VoiceInputState,
  progress: DownloadProgress,
  resolve: MessageResolver = m,
): { status: string | null; active: boolean } {
  switch (state.phase) {
    case "idle":
      return { status: null, active: false };
    case "error":
      return { status: state.error ?? resolve(msg("Voice input failed")), active: false };
    case "preparing":
      return {
        status: progress
          ? resolve(
              msg("Downloading model {percent}%", {
                percent: speechModelDownloadPercent(
                  progress.downloaded,
                  Math.max(1, progress.total),
                ),
              }),
            )
          : resolve(msg("Starting…")),
        active: true,
      };
    case "recording":
      return {
        status: resolve(msg("Recording", { $context: "voice input status" })),
        active: true,
      };
    case "transcribing":
      return { status: resolve(msg("Transcribing…")), active: true };
    case "post-processing":
      return { status: resolve(msg("Cleaning up…")), active: true };
  }
}

function formatElapsed(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function RecordingStatus(props: {
  level: number;
  preparing: boolean;
  recordingStartedAt?: number | null | undefined;
  recordingLimitSeconds?: number | undefined;
}) {
  const { preparing, recordingStartedAt } = props;
  const [elapsedSeconds, setElapsedSeconds] = useState(() =>
    recordingStartedAt ? Math.max(0, Math.floor((Date.now() - recordingStartedAt) / 1_000)) : 0,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the timer displaying the native recording duration
  useEffect(() => {
    if (preparing) return;
    const startedAt = recordingStartedAt ?? Date.now();
    const timer = window.setInterval(
      () => setElapsedSeconds(Math.floor((Date.now() - startedAt) / 1_000)),
      250,
    );
    return () => window.clearInterval(timer);
  }, [preparing, recordingStartedAt]);

  return (
    <>
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          preparing ? "bg-muted-foreground/40" : "bg-destructive",
        )}
      />
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatElapsed(preparing ? 0 : elapsedSeconds)}
        {props.recordingLimitSeconds !== undefined
          ? ` / ${formatElapsed(props.recordingLimitSeconds)}`
          : ""}
      </span>
      <div className="me-1.5 flex w-16 min-w-0 shrink grow">
        <VoiceWaveform level={props.level} />
      </div>
    </>
  );
}

function ShortcutTooltip(props: {
  label: string;
  shortcut?: string | null | undefined;
  children: ReactElement;
}) {
  return (
    <SharedTooltipTrigger
      render={props.children}
      label={
        <>
          {props.label}
          {props.shortcut ? ` (${props.shortcut})` : ""}
        </>
      }
    />
  );
}

export function ComposerSpeechButton(props: {
  state: VoiceInputState;
  shortcutLabel?: string | null;
  disabled?: boolean;
  /** Compact matches the `xs` buttons beside text-field editors. */
  size?: "default" | "compact";
  /** Return the start promise so a released hold can finish once recording begins. */
  onStart(): void | Promise<void>;
  /** Finishes a press held past the dictation hold threshold. */
  onStop?(): void;
}) {
  const gt = useGT();
  const mode = useClientSettings((settings) => settings.voiceShortcutMode);
  if (props.state.phase !== "idle") return null;
  const label = gt("Start voice input");

  const startHold = (event: PointerEvent) => {
    keepFocus(event);
    if (props.disabled || event.button !== 0) return;
    const { onStop } = props;
    const startedAt = performance.now();
    const starting = Promise.resolve(props.onStart());
    // The recording pill replaces this button once dictation starts, so the release is heard on window.
    const release = (releaseEvent: globalThis.PointerEvent | FocusEvent) => {
      if ("pointerId" in releaseEvent && releaseEvent.pointerId !== event.pointerId) return;
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", release, true);
      window.removeEventListener("blur", release);
      if (onStop && shouldFinishDictationOnRelease(mode, performance.now() - startedAt)) {
        void starting.then(onStop);
      }
    };
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", release, true);
    window.addEventListener("blur", release);
  };

  return (
    <ShortcutTooltip label={label} shortcut={props.shortcutLabel}>
      <Button
        type="button"
        size={props.size === "compact" ? "icon-xs" : "icon-sm"}
        variant="ghost"
        aria-label={label}
        disabled={props.disabled}
        onPointerDown={startHold}
        onClick={(event) => {
          // Pointer clicks already started on pointerdown; keyboard and assistive clicks have no detail.
          if (event.detail === 0 && !props.disabled) void props.onStart();
        }}
        className="shrink-0"
      >
        <MatterDictateIcon />
      </Button>
    </ShortcutTooltip>
  );
}

export function ComposerSpeechRecordingPill(props: {
  state: VoiceInputState;
  progress: DownloadProgress;
  finishShortcutLabel?: string | null;
  cancelShortcutLabel?: string | null;
  level: number;
  recordingStartedAt?: number | null | undefined;
  recordingLimitSeconds?: number | undefined;
  /** Compact matches the `xs` buttons beside text-field editors. */
  size?: "default" | "compact";
  onStart(): void;
  disabled?: boolean;
  onStop(): void;
  onCancel(): void;
  onSkipPostProcessing(): void;
}) {
  const gt = useGT();
  const m = useMessages();
  const { phase } = props.state;
  const compact = props.size === "compact";
  if (phase === "error") {
    return (
      <VoiceInputErrorPill
        size={props.size}
        error={props.state.error}
        errorAction={props.state.errorAction}
        errorCode={props.state.errorCode}
        disabled={props.disabled ?? false}
        cancelShortcutLabel={props.cancelShortcutLabel ?? null}
        onRetry={props.onStart}
        onDismiss={props.onCancel}
      />
    );
  }
  const presentation = resolveSpeechPresentation(props.state, props.progress, m);
  if (!presentation.active) return null;
  const recording = phase === "recording";
  const starting = phase === "preparing" && props.progress === null;
  const showRecordingLayout = starting || recording;
  const trailing = showRecordingLayout || phase === "post-processing";

  return (
    <VoiceInputPill size={props.size}>
      <ShortcutTooltip label={gt("Cancel voice input")} shortcut={props.cancelShortcutLabel}>
        <Button
          type="button"
          size={compact ? "icon-xs" : "icon-sm-pill"}
          variant="ghost"
          aria-label={gt("Cancel voice input")}
          onPointerDown={keepFocus}
          onClick={props.onCancel}
          className="shrink-0"
        >
          <XIcon />
        </Button>
      </ShortcutTooltip>
      <div
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2 overflow-hidden",
          !trailing && "pe-2.5",
        )}
        role="status"
        aria-live={recording ? "off" : "polite"}
        aria-label={presentation.status ?? undefined}
      >
        {showRecordingLayout ? (
          <>
            {starting && <span className="sr-only">{presentation.status}</span>}
            <RecordingStatus
              preparing={starting}
              level={starting ? 0 : props.level}
              recordingStartedAt={props.recordingStartedAt}
              recordingLimitSeconds={props.recordingLimitSeconds}
            />
          </>
        ) : (
          <>
            <Spinner aria-hidden size="sm" tone="muted" className="shrink-0" />
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {presentation.status}
            </span>
          </>
        )}
      </div>
      {phase === "post-processing" ? (
        <Button
          type="button"
          size={compact ? "xs" : "sm-pill"}
          variant="ghost"
          onPointerDown={keepFocus}
          onClick={props.onSkipPostProcessing}
          className="shrink-0"
        >
          {gt("Skip", { $context: "verb, skips cleaning up the transcript" })}
        </Button>
      ) : showRecordingLayout ? (
        <ShortcutTooltip label={gt("Finish voice input")} shortcut={props.finishShortcutLabel}>
          <Button
            type="button"
            size={compact ? "icon-xs" : "icon-sm-pill"}
            aria-label={gt("Finish voice input")}
            disabled={starting}
            onPointerDown={keepFocus}
            onClick={props.onStop}
            className="shrink-0"
          >
            {starting ? <Spinner aria-hidden /> : <CheckIcon />}
          </Button>
        </ShortcutTooltip>
      ) : null}
    </VoiceInputPill>
  );
}
