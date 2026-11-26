import type {
  VoiceAssistantClientAction,
  VoiceAssistantToolResult,
  VoiceAssistantTurnResponse,
} from "../../../../../antimatter/voice-assistant/types";
import type { SpokenAudio } from "./voiceAssistantApi";

/** One line of the server's `/turn-stream` NDJSON, mirrored from `apps/server/src/voiceAssistant`. */
export type VoiceTurnStreamEvent =
  | {
      readonly type: "tool_result";
      readonly toolCalls: ReadonlyArray<VoiceAssistantToolResult>;
      readonly actions: ReadonlyArray<VoiceAssistantClientAction>;
    }
  | { readonly type: "text_delta"; readonly text: string }
  | {
      readonly type: "audio_chunk";
      readonly seq: number;
      readonly text: string;
      readonly contentType: string;
      readonly audioBase64: string;
      readonly provider: string | null;
    }
  | {
      readonly type: "done";
      readonly reply: string;
      readonly displayReply: string;
      readonly route: VoiceAssistantTurnResponse["route"];
      readonly expectFollowUp: boolean;
      readonly actions: ReadonlyArray<VoiceAssistantClientAction>;
      readonly toolCalls: ReadonlyArray<VoiceAssistantToolResult>;
    }
  | { readonly type: "error"; readonly message: string };

const EVENT_TYPES = new Set(["tool_result", "text_delta", "audio_chunk", "done", "error"]);

export function parseTurnStreamLine(line: string): VoiceTurnStreamEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      EVENT_TYPES.has((parsed as { readonly type?: unknown }).type as string)
    ) {
      return parsed as VoiceTurnStreamEvent;
    }
  } catch {}
  return null;
}

/** Splits streamed text into NDJSON events; a line split across reads waits for its newline. */
export function createNdjsonReader(onEvent: (event: VoiceTurnStreamEvent) => void) {
  let buffer = "";
  return {
    push(text: string) {
      buffer += text;
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const event = parseTurnStreamLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (event) onEvent(event);
        newline = buffer.indexOf("\n");
      }
    },
    end() {
      const event = parseTurnStreamLine(buffer);
      buffer = "";
      if (event) onEvent(event);
    },
  };
}

/** The `/turn` response a finished stream amounts to. */
export function turnResponseFromDone(
  done: Extract<VoiceTurnStreamEvent, { readonly type: "done" }>,
): VoiceAssistantTurnResponse {
  return {
    route: done.route,
    spokenReply: done.reply,
    displayReply: done.displayReply,
    expectFollowUp: done.expectFollowUp,
    toolResults: done.toolCalls,
    clientActions: done.actions,
  };
}

export function decodeBase64Audio(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** A clip that can pause and resume where it stopped (absent on players that cannot). */
export interface ClipPlayback {
  readonly done: Promise<"finished" | "stopped">;
  stop(): void;
  pause?(): void;
  resume?(): void;
}

/** A clip loaded ahead of its turn so the next sentence starts without a gap. */
export interface PreparedClip {
  start(): Promise<ClipPlayback>;
  discard(): void;
}

/**
 * Plays streamed reply audio back to back. Each clip starts loading the moment it arrives, so
 * sentence 2 is ready when sentence 1 ends. `done` settles "finished" after `end()` once every
 * clip played, or "stopped" on `stop()`.
 */
export function createPlaybackQueue(prepare: (audio: SpokenAudio) => Promise<PreparedClip>) {
  const pending: Array<Promise<PreparedClip | null>> = [];
  let current: ClipPlayback | null = null;
  let ended = false;
  let stopped = false;
  let paused = false;
  let running = false;
  let played = 0;
  let wake: (() => void) | null = null;
  let settle: (outcome: "finished" | "stopped") => void = () => {};
  const done = new Promise<"finished" | "stopped">((resolve) => {
    settle = resolve;
  });

  const nudge = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const waitForWork = () =>
    new Promise<void>((resolve) => {
      wake = resolve;
    });

  // Read through functions: stop()/pause() flip these from outside the loop.
  const isStopped = () => stopped;
  const isHeld = () => paused && !stopped;

  const run = async () => {
    running = true;
    while (!isStopped()) {
      const next = pending.shift();
      if (next === undefined) {
        if (ended) break;
        await waitForWork();
        continue;
      }
      const clip = await next;
      if (clip === null) continue;
      while (isHeld()) await waitForWork();
      if (stopped) {
        clip.discard();
        break;
      }
      try {
        current = await clip.start();
      } catch {
        continue;
      }
      if (stopped) {
        current.stop();
        break;
      }
      if (paused) current.pause?.();
      played += 1;
      const outcome = await current.done;
      current = null;
      if (outcome === "stopped" && stopped) break;
    }
    for (const rest of pending.splice(0)) void rest.then((clip) => clip?.discard());
    settle(stopped ? "stopped" : "finished");
  };

  return {
    done,
    enqueue(audio: SpokenAudio) {
      if (stopped || ended) return;
      pending.push(prepare(audio).catch(() => null));
      if (!running) void run();
      nudge();
    },
    /** No more clips are coming. */
    end() {
      ended = true;
      if (!running) void run();
      nudge();
    },
    pause() {
      if (paused || stopped) return;
      paused = true;
      current?.pause?.();
    },
    resume() {
      if (!paused || stopped) return;
      paused = false;
      current?.resume?.();
      nudge();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      current?.stop();
      nudge();
      if (!running) settle("stopped");
    },
    get paused() {
      return paused;
    },
    /** Clips that started playing so far. */
    get played() {
      return played;
    },
  };
}

export type PlaybackQueue = ReturnType<typeof createPlaybackQueue>;
