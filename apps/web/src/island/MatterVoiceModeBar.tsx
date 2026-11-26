import { useNavigate } from "@tanstack/react-router";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { EllipsisIcon, MicIcon, MicOffIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../components/ui/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../components/ui/menu";
import { SiriWaveVisual, type SiriWaveVisualState } from "./SiriWave";
import { updateVoiceAssistantSettings, useIslandSettings } from "./islandSettingsStore";
import {
  bargeInVoiceAssistant,
  clearVoiceAssistantHistory,
  setVoiceAssistantScopedThread,
  setVoiceModeOpen,
  toggleVoiceAssistantHandsFree,
  toggleVoiceAssistantMute,
  useVoiceAssistantState,
  type VoiceAssistantStoreState,
} from "./voiceAssistantStore";
import { voiceModeThreadKey } from "./voiceModeHost";

function resolveVisualState(state: VoiceAssistantStoreState): SiriWaveVisualState {
  if (state.phase === "speaking" || state.speaking) return "speaking";
  if (state.phase === "thinking" || state.phase === "acting" || state.phase === "transcribing")
    return "thinking";
  if (state.phase === "error") return "error";
  if (state.handsFreeActive && !state.muted) return "listening";
  return "idle";
}

function ThreadLinks(props: {
  readonly turn: VoiceAssistantStoreState["recentTurns"][number];
  readonly hostThreadKey: string | null | undefined;
  readonly scopeKey: string | null;
  readonly onOpen: (environmentId: string, threadId: string) => void;
}) {
  const links = (props.turn.toolResults ?? []).flatMap((result) =>
    result.environmentId &&
    result.threadId &&
    voiceModeThreadKey(result.environmentId, result.threadId) !== props.hostThreadKey &&
    voiceModeThreadKey(result.environmentId, result.threadId) !== props.scopeKey
      ? [{ ...result, environmentId: result.environmentId, threadId: result.threadId }]
      : [],
  );
  if (links.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {links.map((link) => (
        <Button
          key={`${link.tool}-${link.threadId}`}
          type="button"
          size="micro"
          variant="outline"
          onClick={() => props.onOpen(link.environmentId, link.threadId)}
        >
          {link.summary}
        </Button>
      ))}
    </div>
  );
}

/**
 * Voice Mode in the chat: takes the composer's place while a session runs, so the thread stays
 * in view. `floating` is the fallback when no composer is on screen (Settings, pull requests).
 */
export function MatterVoiceModeBar(props: {
  readonly variant: "composer" | "floating";
  /** Thread whose composer hosts the bar; the scope label only shows when it differs. */
  readonly hostThreadKey?: string | null;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const state = useVoiceAssistantState();
  const settings = useIslandSettings();

  const visualState = resolveVisualState(state);
  const level =
    visualState === "speaking"
      ? Math.max(0.22, state.outputLevel)
      : visualState === "listening"
        ? Math.max(0.14, state.inputLevel)
        : 0.15;
  const speaking = visualState === "speaking";

  const headline =
    state.phase === "error" && state.error
      ? state.error
      : state.muted
        ? gt("Muted", { $context: "Voice Mode status" })
        : speaking
          ? state.activeBriefingLabel || gt("Speaking", { $context: "Voice Mode status" })
          : state.phase === "thinking" || state.phase === "acting"
            ? state.statusLabel || gt("Working on it…")
            : state.phase === "transcribing"
              ? gt("Transcribing…")
              : state.handsFreeActive
                ? gt("Listening", { $context: "Voice Mode status" })
                : gt("Paused", { $context: "Voice Mode status" });

  const scope = state.scopedThread;
  const origin = state.originThread;
  const scopeKey = scope ? voiceModeThreadKey(scope.environmentId, scope.threadId) : null;
  const scopeLabel =
    scope === null ? gt("All workspace") : scopeKey !== props.hostThreadKey ? scope.title : null;
  const turns = state.recentTurns.slice(-2);
  // The store keeps the last utterance; once it lands as a turn bubble it isn't news here.
  const lastUserTurn = state.recentTurns.findLast((turn) => turn.role === "user");
  const pendingTranscript =
    state.liveTranscript && state.liveTranscript !== lastUserTurn?.text
      ? state.liveTranscript
      : null;
  const detail = pendingTranscript ? `“${pendingTranscript}”` : scopeLabel;
  const isError = state.phase === "error";

  // The composer hides as the bar mounts; Chromium only moves focus off it at the next layout,
  // so taking it now (from an unringed control) avoids focus recovery ringing the wave button.
  const takeComposerFocus = (node: HTMLDivElement | null) => {
    if (props.variant !== "composer" || node === null) return;
    const active = document.activeElement;
    const area = node.closest("[data-workspace-area]");
    if (active instanceof HTMLElement && !node.contains(active) && area?.contains(active)) {
      node.focus({ preventScroll: true });
    }
  };

  const waveLabel = speaking
    ? gt("Interrupt", { $context: "verb, stops the spoken reply" })
    : state.handsFreeActive
      ? gt("Pause listening")
      : gt("Resume listening");

  return (
    <div
      ref={takeComposerFocus}
      tabIndex={-1}
      data-voice-mode-bar={props.variant}
      className={cn(
        "flex flex-col outline-none",
        props.variant === "floating" &&
          "pointer-events-auto rounded-2xl border border-border bg-popover text-popover-foreground shadow-lg",
      )}
    >
      {turns.length > 0 ? (
        <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto px-3 pt-2.5 pb-0.5 text-sm">
          {turns.map((turn) => (
            <div
              key={turn.id}
              className={cn(
                "max-w-[85%] rounded-xl px-3 py-1.5 leading-relaxed",
                turn.role === "user"
                  ? "self-end bg-muted text-foreground"
                  : "self-start px-0 text-foreground",
              )}
            >
              <p className="line-clamp-4 whitespace-pre-wrap">{turn.text}</p>
              <ThreadLinks
                turn={turn}
                hostThreadKey={props.hostThreadKey}
                scopeKey={scopeKey}
                onOpen={(environmentId, threadId) =>
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: {
                      environmentId: EnvironmentId.make(environmentId),
                      threadId: ThreadId.make(threadId),
                    },
                  })
                }
              />
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex min-w-0 items-center gap-2 p-2">
        <button
          type="button"
          onClick={() => (speaking ? bargeInVoiceAssistant() : toggleVoiceAssistantHandsFree())}
          aria-label={waveLabel}
          className="flex h-9 w-24 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full bg-muted/48 ring-1 ring-border ring-inset outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
        >
          <SiriWaveVisual state={visualState} level={level} width={88} height={28} />
        </button>
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p
            className={cn(
              "text-sm",
              isError ? "line-clamp-2 text-destructive" : "truncate font-medium text-foreground",
            )}
          >
            {headline}
          </p>
          {detail ? <p className="truncate text-xs text-muted-foreground">{detail}</p> : null}
        </div>
        <Menu>
          <MenuTrigger
            render={
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label={gt("Voice Mode options")}
                className="shrink-0"
              />
            }
          >
            <EllipsisIcon className="size-4.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top">
            {origin !== null ? (
              <>
                <MenuGroup>
                  <MenuGroupLabel>
                    {gt("Talk about", { $context: "Voice Mode scope menu heading" })}
                  </MenuGroupLabel>
                  <MenuRadioGroup
                    value={scope === null ? "workspace" : "thread"}
                    onValueChange={(value) =>
                      setVoiceAssistantScopedThread(value === "thread" ? origin : null)
                    }
                  >
                    <MenuRadioItem value="thread" closeOnClick>
                      <span className="block max-w-56 truncate">{origin.title}</span>
                    </MenuRadioItem>
                    <MenuRadioItem value="workspace" closeOnClick>
                      {gt("All workspace")}
                    </MenuRadioItem>
                  </MenuRadioGroup>
                </MenuGroup>
                <MenuSeparator />
              </>
            ) : null}
            <MenuCheckboxItem
              variant="switch"
              checked={settings.voiceAssistant.proactiveBriefings}
              onCheckedChange={(checked) =>
                updateVoiceAssistantSettings({ proactiveBriefings: checked })
              }
            >
              {gt("Spoken briefings")}
            </MenuCheckboxItem>
            <MenuItem
              disabled={state.recentTurns.length === 0}
              onClick={() => clearVoiceAssistantHistory()}
            >
              {gt("Clear conversation")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem
              onClick={() => {
                setVoiceModeOpen(false);
                void navigate({ to: "/settings/general", hash: "matter-voice-assistant" });
              }}
            >
              {gt("Voice settings…")}
            </MenuItem>
          </MenuPopup>
        </Menu>
        <Button
          type="button"
          size="icon-sm"
          variant={state.muted ? "destructive-outline" : "ghost"}
          aria-label={
            state.muted
              ? gt("Unmute", { $context: "verb, microphone" })
              : gt("Mute", { $context: "verb, microphone" })
          }
          aria-pressed={state.muted}
          disabled={!state.handsFreeActive}
          onClick={() => toggleVoiceAssistantMute()}
          className="shrink-0"
        >
          {state.muted ? <MicOffIcon /> : <MicIcon />}
        </Button>
        <Button
          type="button"
          size="sm-pill"
          variant="secondary"
          onClick={() => setVoiceModeOpen(false)}
          className="shrink-0"
        >
          <XIcon />
          {gt("End", { $context: "verb, ends Voice Mode" })}
        </Button>
      </div>
    </div>
  );
}
