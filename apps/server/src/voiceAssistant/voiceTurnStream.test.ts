import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type {
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceSpeakRequest,
} from "../../../../antimatter/voice-assistant/types.ts";
import type * as VoiceAssistantService from "./VoiceAssistantService.ts";
import { encodeVoiceTurnStream, makeVoiceTurnStream } from "./voiceTurnStream.ts";
import type * as VoiceTtsService from "./VoiceTtsService.ts";

const request: VoiceAssistantTurnRequest = {
  utterance: "what's running",
  mode: "voice-mode",
  history: [],
  context: {
    activeEnvironmentId: null,
    activeThreadId: null,
    activeRoute: null,
    mainWindowFocused: true,
    composerFocused: false,
    projects: [],
    threads: [],
    pendingApprovals: [],
    pendingQuestions: [],
  },
};

const response = (
  overrides: Partial<VoiceAssistantTurnResponse> = {},
): VoiceAssistantTurnResponse => ({
  route: "assistant",
  spokenReply: "Sure thing. The build passed!",
  displayReply: "Build passed",
  expectFollowUp: false,
  toolResults: [],
  clientActions: [],
  ...overrides,
});

function fakeAssistant(
  run: VoiceAssistantService.VoiceAssistantService["Service"]["streamTurn"],
): VoiceAssistantService.VoiceAssistantService["Service"] {
  return {
    handleTurn: () => Effect.die("unused"),
    generateBriefing: () => Effect.die("unused"),
    streamTurn: run,
  };
}

function fakeTts(
  speak: (req: VoiceSpeakRequest) => Effect.Effect<VoiceTtsService.VoiceTtsSpeakResult>,
): VoiceTtsService.VoiceTtsService["Service"] {
  return { speak } as unknown as VoiceTtsService.VoiceTtsService["Service"];
}

const audioOf = (text: string): VoiceTtsService.VoiceTtsSpeakResult => ({
  bytes: new TextEncoder().encode(text),
  contentType: "audio/mpeg",
  provider: "elevenlabs",
});

describe("makeVoiceTurnStream", () => {
  it.effect("streams text, then sentence audio strictly in order, then done", () =>
    Effect.gen(function* () {
      const spoken: string[] = [];
      const secondSynthesized = yield* Deferred.make<void>();
      const stream = makeVoiceTurnStream({
        request,
        speak: { provider: "elevenlabs" },
        assistant: fakeAssistant((_req, hooks) =>
          Effect.gen(function* () {
            yield* hooks.onSpokenDelta("Sure thing.");
            yield* hooks.onSpokenDelta(" The build ");
            yield* hooks.onSpokenDelta("passed!");
            return response();
          }),
        ),
        // The first sentence is the slowest to synthesize, yet it must still arrive first.
        tts: fakeTts((req) =>
          req.text === "Sure thing."
            ? Deferred.await(secondSynthesized).pipe(
                Effect.andThen(Effect.sync(() => spoken.push(req.text))),
                Effect.as(audioOf(req.text)),
              )
            : Effect.sync(() => spoken.push(req.text)).pipe(
                Effect.andThen(Deferred.succeed(secondSynthesized, undefined)),
                Effect.as(audioOf(req.text)),
              ),
        ),
      });
      const events = yield* Stream.runCollect(stream);

      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["text_delta", "text_delta", "text_delta", "audio_chunk", "audio_chunk", "done"],
      );
      const chunks = events.flatMap((event) => (event.type === "audio_chunk" ? [event] : []));
      assert.deepStrictEqual(
        chunks.map((chunk) => [chunk.seq, chunk.text, chunk.provider]),
        [
          [0, "Sure thing.", "elevenlabs"],
          [1, "The build passed!", "elevenlabs"],
        ],
      );
      assert.strictEqual(
        Buffer.from(chunks[0]!.audioBase64, "base64").toString("utf8"),
        "Sure thing.",
      );
      // Synthesis ran in parallel: the second sentence finished before the first.
      assert.deepStrictEqual(spoken, ["The build passed!", "Sure thing."]);
      const done = events.at(-1);
      assert.deepStrictEqual(done, {
        type: "done",
        reply: "Sure thing. The build passed!",
        displayReply: "Build passed",
        route: "assistant",
        expectFollowUp: false,
        actions: [],
        toolCalls: [],
      });
    }),
  );

  it.effect("delivers tool results first and speaks a reply that came after the tool round", () =>
    Effect.gen(function* () {
      const toolCalls = [{ tool: "launch_thread", ok: true, summary: "Launched Audit" }];
      const stream = makeVoiceTurnStream({
        request,
        speak: {},
        assistant: fakeAssistant((_req, hooks) =>
          hooks
            .onToolResults(toolCalls, [{ type: "focus-window" }])
            .pipe(
              Effect.as(
                response({ spokenReply: "Launched the audit thread.", toolResults: toolCalls }),
              ),
            ),
        ),
        tts: fakeTts((req) => Effect.succeed(audioOf(req.text))),
      });
      const events = yield* Stream.runCollect(stream);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["tool_result", "text_delta", "audio_chunk", "done"],
      );
      assert.deepStrictEqual(events[0], {
        type: "tool_result",
        toolCalls,
        actions: [{ type: "focus-window" }],
      });
    }),
  );

  it.effect("streams text only when speech is off", () =>
    Effect.gen(function* () {
      let ttsCalls = 0;
      const stream = makeVoiceTurnStream({
        request,
        speak: null,
        assistant: fakeAssistant((_req, hooks) =>
          hooks.onSpokenDelta("Sure thing. Done.").pipe(Effect.as(response())),
        ),
        tts: fakeTts((req) => Effect.sync(() => ttsCalls++).pipe(Effect.as(audioOf(req.text)))),
      });
      const events = yield* Stream.runCollect(stream);
      assert.deepStrictEqual(
        events.map((event) => event.type),
        ["text_delta", "done"],
      );
      assert.strictEqual(ttsCalls, 0);
    }),
  );

  it.effect("ending the stream early interrupts the model and every pending TTS call", () =>
    Effect.gen(function* () {
      let ttsStarted = 0;
      let ttsInterrupted = 0;
      let modelInterrupted = false;
      const stream = makeVoiceTurnStream({
        request,
        speak: { provider: "elevenlabs" },
        assistant: fakeAssistant((_req, hooks) =>
          Effect.gen(function* () {
            yield* hooks.onSpokenDelta("First sentence. Second sentence. ");
            return yield* Effect.never;
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                modelInterrupted = true;
              }),
            ),
          ),
        ),
        tts: fakeTts(() =>
          Effect.sync(() => ttsStarted++).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                ttsInterrupted++;
              }),
            ),
          ),
        ),
      });

      // A client that disconnects after the first event (a confirmed barge-in).
      const first = yield* Stream.runCollect(Stream.take(stream, 1));
      assert.strictEqual(first[0]?.type, "text_delta");
      yield* Effect.yieldNow;
      assert.isTrue(modelInterrupted);
      assert.strictEqual(ttsInterrupted, ttsStarted);
    }),
  );

  it.effect("reports a failed turn as an error event", () =>
    Effect.gen(function* () {
      const stream = makeVoiceTurnStream({
        request,
        speak: {},
        assistant: fakeAssistant(() => Effect.die("boom")),
        tts: fakeTts((req) => Effect.succeed(audioOf(req.text))),
      });
      const events = yield* Stream.runCollect(stream);
      assert.deepStrictEqual(events, [{ type: "error", message: "Voice turn failed." }]);
    }),
  );

  it.effect("encodes events as newline-delimited JSON", () =>
    Effect.gen(function* () {
      const bytes = yield* Stream.runCollect(
        encodeVoiceTurnStream(Stream.make({ type: "text_delta", text: "Hi" } as const)),
      );
      const text = bytes.map((part) => new TextDecoder().decode(part)).join("");
      assert.strictEqual(text, '{"type":"text_delta","text":"Hi"}\n');
    }),
  );
});
