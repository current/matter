import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type {
  VoiceAssistantClientAction,
  VoiceAssistantToolResult,
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceSpeakRequest,
} from "../../../../antimatter/voice-assistant/types.ts";
import type { VoiceAssistantService } from "./VoiceAssistantService.ts";
import { createSentenceChunker } from "./voiceSentenceChunker.ts";
import type { VoiceTtsService, VoiceTtsSpeakResult } from "./VoiceTtsService.ts";

/** One NDJSON line of `/api/mattr/voice-assistant/turn-stream`, in delivery order. */
export type VoiceTurnStreamEvent =
  | {
      readonly type: "tool_result";
      readonly toolCalls: ReadonlyArray<VoiceAssistantToolResult>;
      /** Client actions to apply now; `done` repeats them for clients that wait. */
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

// Sentences synthesize ahead of playback, but a long reply must not open a call per sentence.
const MAX_PARALLEL_TTS = 3;

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/**
 * Runs one voice turn as a stream: spoken text goes to TTS sentence by sentence while the model
 * keeps writing, and audio comes back strictly in order. Ending the stream early (the client hung
 * up after a barge-in) interrupts the model call and every pending TTS request.
 */
export function makeVoiceTurnStream(input: {
  readonly request: VoiceAssistantTurnRequest;
  readonly assistant: VoiceAssistantService["Service"];
  readonly tts: VoiceTtsService["Service"];
  /** Speak options without text; null streams text only (TTS off or browser speech). */
  readonly speak: Omit<VoiceSpeakRequest, "text"> | null;
}): Stream.Stream<VoiceTurnStreamEvent> {
  return Stream.callback<VoiceTurnStreamEvent>((events) =>
    Effect.gen(function* () {
      const emit = (event: VoiceTurnStreamEvent) => Queue.offer(events, event).pipe(Effect.asVoid);
      const scope = yield* Effect.scope;
      const semaphore = yield* Semaphore.make(MAX_PARALLEL_TTS);
      const synthesized = yield* Queue.unbounded<
        { readonly text: string; readonly fiber: Fiber.Fiber<VoiceTtsSpeakResult | null> },
        Cause.Done
      >();

      const speakOptions = input.speak;
      const chunker = createSentenceChunker();
      let spokenText = "";
      const synthesize = (text: string) =>
        speakOptions === null
          ? Effect.void
          : input.tts.speak({ ...speakOptions, text }).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Streaming TTS chunk failed.", { error }).pipe(Effect.as(null)),
              ),
              Semaphore.withPermit(semaphore),
              Effect.forkIn(scope),
              Effect.flatMap((fiber) => Queue.offer(synthesized, { text, fiber })),
            );
      const sendChunks = (chunks: ReadonlyArray<string>) =>
        Effect.forEach(chunks, synthesize, { discard: true });

      const player = yield* Effect.forkScoped(
        Effect.gen(function* () {
          let seq = 0;
          yield* Stream.fromQueue(synthesized).pipe(
            Stream.runForEach(({ text, fiber }) =>
              Fiber.join(fiber).pipe(
                Effect.flatMap((audio) =>
                  audio === null
                    ? Effect.void
                    : emit({
                        type: "audio_chunk",
                        seq: seq++,
                        text,
                        contentType: audio.contentType,
                        audioBase64: toBase64(audio.bytes),
                        provider: audio.provider ?? null,
                      }),
                ),
              ),
            ),
          );
        }),
      );

      const response = yield* input.assistant.streamTurn(input.request, {
        onSpokenDelta: (text) => {
          spokenText += text;
          return emit({ type: "text_delta", text }).pipe(
            Effect.andThen(sendChunks(chunker.push(text))),
          );
        },
        onToolResults: (toolCalls, actions) => emit({ type: "tool_result", toolCalls, actions }),
      });

      if (spokenText.length === 0 && response.spokenReply.length > 0) {
        // The reply depended on a tool round (or came back whole), so it is spoken now.
        yield* emit({ type: "text_delta", text: response.spokenReply });
        // Dictation confirmations are shown, never read aloud (same rule as `/turn` clients).
        if (response.route !== "dictation") yield* sendChunks(chunker.push(response.spokenReply));
      }
      yield* sendChunks(chunker.flush());
      yield* Queue.end(synthesized);
      yield* Fiber.join(player);
      yield* emit({
        type: "done",
        reply: response.spokenReply,
        displayReply: response.displayReply,
        route: response.route,
        expectFollowUp: response.expectFollowUp,
        actions: response.clientActions,
        toolCalls: response.toolResults,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Voice turn stream failed.", { cause }).pipe(
          Effect.andThen(Queue.offer(events, { type: "error", message: "Voice turn failed." })),
        ),
      ),
      Effect.ensuring(Queue.end(events)),
    ),
  );
}

/** NDJSON bytes for the HTTP response body. */
export function encodeVoiceTurnStream(
  stream: Stream.Stream<VoiceTurnStreamEvent>,
): Stream.Stream<Uint8Array> {
  return stream.pipe(
    Stream.map((event) => `${JSON.stringify(event)}\n`),
    Stream.encodeText,
  );
}
