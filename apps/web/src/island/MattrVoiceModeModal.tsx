import { msg, T, useGT, useMessages } from "gt-react";
import {
  ArrowUpIcon,
  AudioWaveformIcon,
  BellIcon,
  BellOffIcon,
  CheckIcon,
  MessageSquareTextIcon,
  MicIcon,
  MicOffIcon,
  RadioIcon,
  SettingsIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  IslandPendingApproval,
  IslandPendingUserInput,
  IslandThreadSummary,
  IslandVoicePanelMode,
} from "../../../../antimatter/island/types";
import { Button } from "../components/ui/button";
import { SiriWaveVisual } from "./SiriWave";
import { updateVoiceAssistantSettings, useIslandSettings } from "./islandSettingsStore";
import {
  bargeInVoiceAssistant,
  clearVoiceAssistantHistory,
  setVoiceAssistantModalOpen,
  setVoiceAssistantMode,
  submitVoiceAssistantUtterance,
  toggleVoiceAssistantHandsFree,
  toggleVoiceAssistantMute,
  useVoiceAssistantState,
} from "./voiceAssistantStore";

interface MattrVoiceModeModalProps {
  readonly activeThreads: ReadonlyArray<IslandThreadSummary>;
  readonly pendingApprovals: ReadonlyArray<IslandPendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<IslandPendingUserInput>;
  readonly voiceLevel: number;
  readonly onApprove: (
    approval: IslandPendingApproval,
    decision: "accept" | "acceptForSession" | "decline",
  ) => void;
  readonly onOpenThread: (environmentId: string, threadId: string) => void;
  readonly onOpenSettings: () => void;
}

const MODE_OPTIONS: ReadonlyArray<{
  readonly value: IslandVoicePanelMode;
  readonly label: string;
}> = [
  { value: "voice-mode", label: msg("Voice Mode") },
  { value: "smart", label: msg("Smart") },
  { value: "assistant", label: msg("Assistant") },
];

export function MattrVoiceModeModal({
  activeThreads,
  pendingApprovals,
  pendingUserInputs,
  voiceLevel,
  onApprove,
  onOpenThread,
  onOpenSettings,
}: MattrVoiceModeModalProps) {
  const gt = useGT();
  const messages = useMessages();
  const state = useVoiceAssistantState();
  const settings = useIslandSettings();
  const [draft, setDraft] = useState("");
  const [showTranscript, setShowTranscript] = useState(true);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes Voice Mode overlay on Escape
  useEffect(() => {
    if (!state.modalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setVoiceAssistantModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state.modalOpen]);

  if (!state.modalOpen) return null;

  const visualState =
    state.phase === "speaking" || state.speaking
      ? "speaking"
      : state.phase === "thinking" || state.phase === "acting" || state.phase === "transcribing"
        ? "thinking"
        : state.phase === "listening"
          ? "listening"
          : state.phase === "error"
            ? "error"
            : "idle";

  const visualLevel =
    visualState === "speaking"
      ? Math.max(0.22, state.outputLevel)
      : visualState === "listening"
        ? Math.max(0.14, voiceLevel, state.inputLevel)
        : 0.15;

  const statusHeadline = state.muted
    ? gt("Microphone muted")
    : state.phase === "speaking" || state.speaking
      ? state.activeBriefingLabel || gt("Speaking. Tap orb or speak to interrupt")
      : state.phase === "thinking" || state.phase === "acting"
        ? state.statusLabel || gt("Working on it…")
        : state.phase === "transcribing"
          ? gt("Transcribing…")
          : state.phase === "listening"
            ? state.handsFreeActive
              ? gt("Listening hands-free")
              : gt("Listening…")
            : state.handsFreeActive
              ? gt("Ready. Just start speaking")
              : gt("Tap the orb to start Hands-Free Voice Mode");

  const runningThreads = activeThreads.filter((t) => t.status === "running");

  const handleSubmit = (event?: React.FormEvent) => {
    event?.preventDefault();
    const trimmed = draft.trim();
    if (!trimmed) return;
    setDraft("");
    void submitVoiceAssistantUtterance(trimmed, {
      modeOverride: state.mode === "dictation" ? "smart" : state.mode,
      speakOverride: true,
    });
  };

  const handleOrbClick = () => {
    if (state.speaking || state.phase === "speaking") {
      bargeInVoiceAssistant();
      return;
    }
    toggleVoiceAssistantHandsFree();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-2xl"
      role="dialog"
      aria-modal="true"
      aria-label={gt("mattr Voice Mode")}
    >
      {/* Top Bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border/50 px-4 py-3 sm:px-6">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="inline-flex size-7 items-center justify-center rounded-full bg-primary/12 text-primary">
            <AudioWaveformIcon className="size-3.5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold tracking-tight text-foreground">
                <T>mattr Voice</T>
              </span>
              {state.handsFreeActive ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-2xs font-medium text-success">
                  <RadioIcon className="size-3" />
                  <T>Live</T>
                </span>
              ) : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">
              {gt("{running} active · {approvals} waiting", {
                running: String(runningThreads.length),
                approvals: String(pendingApprovals.length + pendingUserInputs.length),
              })}
            </p>
          </div>
        </div>

        {/* Mode selector */}
        <div className="hidden items-center gap-1 rounded-full border border-border/70 bg-muted/40 p-0.5 sm:flex">
          {MODE_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setVoiceAssistantMode(opt.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                state.mode === opt.value
                  ? "bg-foreground text-background"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {messages(opt.label)}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            size="xs"
            variant={settings.voiceAssistant.proactiveBriefings ? "secondary" : "ghost"}
            onClick={() =>
              updateVoiceAssistantSettings({
                proactiveBriefings: !settings.voiceAssistant.proactiveBriefings,
              })
            }
            title={gt("Proactively speak thread completions, approvals, and errors")}
          >
            {settings.voiceAssistant.proactiveBriefings ? (
              <BellIcon className="size-3.5" />
            ) : (
              <BellOffIcon className="size-3.5" />
            )}
            <span className="hidden sm:inline">
              {settings.voiceAssistant.proactiveBriefings ? <T>Briefings on</T> : <T>Quiet</T>}
            </span>
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant={showTranscript ? "secondary" : "ghost"}
            onClick={() => setShowTranscript((v) => !v)}
            aria-label={gt("Toggle transcript")}
            title={gt("Toggle transcript")}
          >
            <MessageSquareTextIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={() => {
              setVoiceAssistantModalOpen(false);
              onOpenSettings();
            }}
            aria-label={gt("Voice Mode settings")}
            title={gt("Voice Mode settings")}
          >
            <SettingsIcon className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            onClick={() => setVoiceAssistantModalOpen(false)}
            aria-label={gt("Close Voice Mode")}
            title={gt("Close (Esc)")}
          >
            <XIcon className="size-4" />
          </Button>
        </div>
      </div>

      {/* Main Stage */}
      <div className="scrollbar-gutter-both mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col items-center justify-between gap-4 overflow-y-auto px-4 py-6 sm:px-6">
        {/* Pending approvals strip (one-tap or say "approve") */}
        {pendingApprovals.length > 0 ? (
          <div className="w-full space-y-2">
            {pendingApprovals.slice(0, 2).map((approval) => (
              <div
                key={approval.requestId}
                className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-warning/30 bg-warning/10 px-3.5 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-semibold text-foreground">
                    {approval.title} · {approval.threadTitle}
                  </p>
                  {approval.detail ? (
                    <p className="truncate font-mono text-2xs text-muted-foreground">
                      {approval.detail}
                    </p>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button type="button" size="xs" onClick={() => onApprove(approval, "accept")}>
                    <CheckIcon className="size-3" />
                    <T>Allow</T>
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => onApprove(approval, "decline")}
                  >
                    <T>Deny</T>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {/* Siri Wave Orb */}
        <div className="flex flex-col items-center justify-center gap-4 py-2 text-center">
          <button
            type="button"
            onClick={handleOrbClick}
            className="group relative flex size-52 cursor-pointer items-center justify-center rounded-full bg-popover/60 ring-1 ring-border/60 transition-transform active:scale-95 sm:size-60"
            aria-label={statusHeadline}
          >
            <SiriWaveVisual state={visualState} level={visualLevel} width={210} height={210} />
          </button>

          <div className="max-w-lg space-y-1.5">
            <p className="text-sm font-medium text-foreground">{statusHeadline}</p>
            {state.liveTranscript ? (
              <p className="rounded-xl bg-muted/50 px-3 py-1.5 text-sm text-foreground/90">
                “{state.liveTranscript}”
              </p>
            ) : null}
            {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
          </div>
        </div>

        {/* Conversation Transcript & Tool Actions */}
        {showTranscript ? (
          <div className="w-full space-y-2">
            {state.recentTurns.length > 0 ? (
              <div className="flex items-center justify-between px-1">
                <span className="text-2xs font-medium uppercase tracking-wider text-muted-foreground">
                  <T>Session</T>
                </span>
                <button
                  type="button"
                  onClick={() => clearVoiceAssistantHistory()}
                  className="inline-flex items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
                >
                  <Trash2Icon className="size-3" />
                  <T>Clear</T>
                </button>
              </div>
            ) : null}
            <div className="max-h-52 space-y-2 overflow-y-auto pr-1">
              {state.recentTurns.length === 0 ? (
                <div className="rounded-2xl border border-border/50 bg-muted/25 px-4 py-3 text-center text-xs text-muted-foreground">
                  <T>
                    Try saying: “What’s running right now?”, “Create a project for Placket and
                    launch two audit threads”, or “Tell the auth thread to add unit tests.”
                  </T>
                </div>
              ) : (
                state.recentTurns.slice(-8).map((turn) => (
                  <div
                    key={turn.id}
                    className={
                      turn.role === "user"
                        ? "ml-auto max-w-[85%] rounded-2xl bg-primary/12 px-3.5 py-2 text-xs text-foreground"
                        : turn.role === "briefing"
                          ? "mr-auto max-w-[92%] rounded-2xl border border-warning/30 bg-warning/10 px-3.5 py-2 text-xs text-foreground"
                          : "mr-auto max-w-[92%] rounded-2xl border border-border/60 bg-card/80 px-3.5 py-2 text-xs text-foreground"
                    }
                  >
                    <p className="leading-relaxed">{turn.text}</p>
                    {turn.toolResults && turn.toolResults.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {turn.toolResults.map((tr) => (
                          <button
                            key={`${turn.id}-${tr.tool}-${tr.threadId ?? tr.projectId ?? tr.summary}`}
                            type="button"
                            disabled={!tr.environmentId || !tr.threadId}
                            onClick={() => {
                              if (tr.environmentId && tr.threadId) {
                                setVoiceAssistantModalOpen(false);
                                onOpenThread(tr.environmentId, tr.threadId);
                              }
                            }}
                            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-medium ${
                              tr.ok
                                ? "bg-success/15 text-success"
                                : "bg-destructive/15 text-destructive"
                            } ${tr.environmentId && tr.threadId ? "cursor-pointer hover:underline" : ""}`}
                          >
                            <span>{tr.ok ? "✓" : "!"}</span>
                            <span>{tr.summary}</span>
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : null}
      </div>

      {/* Car-Friendly Bottom Controls */}
      <div
        className="shrink-0 border-t border-border/50 bg-background/80 px-4 pt-4 sm:px-6"
        style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}
      >
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-3">
          <div className="flex items-center justify-center gap-3">
            <Button
              type="button"
              size="lg"
              variant={state.muted ? "destructive" : "outline"}
              className="h-12 min-w-28"
              onClick={() => toggleVoiceAssistantMute()}
              disabled={!state.handsFreeActive}
            >
              {state.muted ? <MicOffIcon className="size-4" /> : <MicIcon className="size-4" />}
              <span>{state.muted ? <T>Unmute</T> : <T>Mute</T>}</span>
            </Button>

            <Button
              type="button"
              size="lg"
              variant={state.handsFreeActive ? "destructive" : "default"}
              className="h-12 min-w-44"
              onClick={() => toggleVoiceAssistantHandsFree()}
            >
              <RadioIcon className="size-4" />
              <span>{state.handsFreeActive ? <T>End Voice Mode</T> : <T>Start Voice Mode</T>}</span>
            </Button>
          </div>

          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
              placeholder={gt("Or type a command for mattr Assistant…")}
              className="h-10 min-w-0 flex-1 rounded-full border border-border/70 bg-muted/35 px-4 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-ring"
            />
            <Button
              type="submit"
              size="icon"
              className="size-10 shrink-0"
              disabled={draft.trim().length === 0}
              aria-label={gt("Send to mattr Assistant")}
            >
              <ArrowUpIcon className="size-4" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
