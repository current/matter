import { describe, expect, it, vi } from "vite-plus/test";

import type {
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceWorkspaceContext,
} from "../../../../../antimatter/voice-assistant/types";
import type { ActiveListening, ActivePlayback, ListenResult } from "./nativeVoiceAudio";
import type { VoiceAssistantApi } from "./voiceAssistantApi";
import { VoiceModeSession, type VoiceModeAudio, type VoicePhase } from "./voiceModeSession";

const EMPTY_CONTEXT: VoiceWorkspaceContext = {
  activeEnvironmentId: null,
  activeThreadId: null,
  activeRoute: null,
  mainWindowFocused: true,
  composerFocused: false,
  projects: [],
  threads: [],
  pendingApprovals: [],
  pendingQuestions: [],
};

const reply = (
  overrides: Partial<VoiceAssistantTurnResponse> = {},
): VoiceAssistantTurnResponse => ({
  route: "assistant",
  spokenReply: "Sure thing.",
  displayReply: "Sure thing.",
  expectFollowUp: false,
  toolResults: [],
  clientActions: [],
  ...overrides,
});

function harness(
  options: { readonly turn?: () => VoiceAssistantTurnResponse; readonly noTts?: boolean } = {},
) {
  const listens: Array<{
    resolve: (result: ListenResult) => void;
    finish: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  }> = [];
  const playbacks: Array<{ finish: () => void; stop: ReturnType<typeof vi.fn> }> = [];
  const turns: VoiceAssistantTurnRequest[] = [];
  const phases: VoicePhase[] = [];
  const transcripts: string[] = ["what's running", "approve it", "thanks"];

  const audio: VoiceModeAudio = {
    open: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    listen: vi.fn(async () => {
      let resolve!: (result: ListenResult) => void;
      const result = new Promise<ListenResult>((r) => {
        resolve = r;
      });
      const entry = {
        resolve,
        finish: vi.fn(() =>
          resolve({ kind: "utterance", uri: "file:///a.m4a", heardSpeech: true }),
        ),
        cancel: vi.fn(() => resolve({ kind: "cancelled" })),
      };
      listens.push(entry);
      return { result, finish: entry.finish, cancel: entry.cancel } satisfies ActiveListening;
    }),
    watchForBargeIn: vi.fn(async () => async () => {}),
    play: vi.fn(async () => {
      let finish!: () => void;
      let stopNow!: () => void;
      const done = new Promise<"finished" | "stopped">((resolve) => {
        finish = () => resolve("finished");
        stopNow = () => resolve("stopped");
      });
      const entry = { finish, stop: vi.fn(() => stopNow()) };
      playbacks.push(entry);
      return { done, stop: entry.stop } satisfies ActivePlayback;
    }),
    transcribe: vi.fn(async () => transcripts.shift() ?? ""),
    discardRecording: vi.fn(),
  };
  const api = {
    turn: vi.fn(async (request: VoiceAssistantTurnRequest) => {
      turns.push(request);
      return (options.turn ?? (() => reply()))();
    }),
    speak: vi.fn(async () => {
      if (options.noTts) throw new Error("no tts");
      return { bytes: new Uint8Array([1]), contentType: "audio/mpeg" };
    }),
  } as unknown as VoiceAssistantApi;
  const executeAction = vi.fn(async () => {});
  const session = new VoiceModeSession({
    audio,
    getApi: () => api,
    readContext: () => EMPTY_CONTEXT,
    watchWorkspace: () => () => {},
    executeAction,
    setLevel: () => {},
  });
  session.subscribe(() => phases.push(session.getSnapshot().phase));
  return { session, audio, api, listens, playbacks, turns, phases, executeAction };
}

const speech: ListenResult = { kind: "utterance", uri: "file:///a.m4a", heardSpeech: true };

describe("VoiceModeSession", () => {
  it("runs listen → transcribe → turn → speak and listens again", async () => {
    const { session, listens, playbacks, turns } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    expect(session.getSnapshot().phase).toBe("listening");

    listens[0]!.resolve(speech);
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));
    expect(session.getSnapshot().phase).toBe("speaking");
    expect(turns[0]).toMatchObject({
      utterance: "what's running",
      mode: "voice-mode",
      history: [],
    });
    expect(session.getSnapshot().turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["user", "what's running"],
      ["assistant", "Sure thing."],
    ]);

    playbacks[0]!.finish();
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    expect(session.getSnapshot().phase).toBe("listening");

    listens[1]!.resolve(speech);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]!.history.map((message) => message.role)).toEqual(["user", "assistant"]);
    await session.stop();
  });

  it("applies client actions and shows tool results as badges", async () => {
    const action = {
      type: "respond-approval",
      environmentId: "env-1",
      threadId: "t1",
      requestId: "r1",
      decision: "accept",
    } as const;
    const { session, listens, executeAction } = harness({
      turn: () =>
        reply({
          spokenReply: "",
          toolResults: [{ tool: "approve", ok: true, summary: "Approved the command" }],
          clientActions: [action],
        }),
    });
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    listens[0]!.resolve(speech);

    // No spoken reply means the loop goes straight back to listening.
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    expect(executeAction).toHaveBeenCalledWith(action);
    expect(session.getSnapshot().turns.at(-1)?.toolBadges).toMatchObject([
      { label: "Approved the command", ok: true },
    ]);
    await session.stop();
  });

  it("tapping the orb while speaking stops playback and listens", async () => {
    const { session, listens, playbacks } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    listens[0]!.resolve(speech);
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));

    session.tapOrb();
    expect(playbacks[0]!.stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    await session.stop();
  });

  it("tapping the orb while hearing sends the recording now", async () => {
    const { session, listens } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    session.tapOrb();
    expect(listens[0]!.finish).toHaveBeenCalled();
    await session.stop();
  });

  it("pauses when the orb is tapped before anyone spoke", async () => {
    const { session, audio, listens, turns } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    listens[0]!.finish.mockImplementation(() =>
      listens[0]!.resolve({ kind: "utterance", uri: "file:///a.m4a", heardSpeech: false }),
    );
    session.tapOrb();
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe("paused"));
    expect(turns).toHaveLength(0);
    expect(audio.discardRecording).toHaveBeenCalledWith("file:///a.m4a");

    session.tapOrb();
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    await session.stop();
  });

  it("keeps the reply on screen when the server has no speech provider", async () => {
    const { session, listens, playbacks } = harness({ noTts: true });
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    listens[0]!.resolve(speech);
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    expect(playbacks).toHaveLength(0);
    expect(session.getSnapshot().turns.at(-1)?.text).toBe("Sure thing.");
    await session.stop();
  });

  it("muting stops the microphone and unmuting resumes it", async () => {
    const { session, listens } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));

    session.setMuted(true);
    expect(listens[0]!.cancel).toHaveBeenCalled();
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe("muted"));
    expect(listens).toHaveLength(1);

    session.setMuted(false);
    await vi.waitFor(() => expect(listens).toHaveLength(2));
    await session.stop();
  });

  it("sends typed text as a turn", async () => {
    const { session, listens, turns } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));

    session.sendText("  list my threads ");
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]!.utterance).toBe("list my threads");
    expect(listens[0]!.cancel).toHaveBeenCalled();
    await session.stop();
  });

  it("stays on one turn when hands-free is off", async () => {
    const { session, listens, playbacks } = harness();
    session.start();
    session.setHandsFree(false);
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    listens[0]!.resolve(speech);
    await vi.waitFor(() => expect(playbacks).toHaveLength(1));
    playbacks[0]!.finish();

    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe("paused"));
    expect(listens).toHaveLength(1);
    await session.stop();
  });

  it("reports a microphone failure and retries it on a tap", async () => {
    const { session, audio, listens } = harness();
    session.setHandsFree(false);
    vi.mocked(audio.open).mockRejectedValueOnce(new Error("Microphone access is turned off."));
    session.start();
    await vi.waitFor(() =>
      expect(session.getSnapshot()).toMatchObject({
        phase: "error",
        error: "Microphone access is turned off.",
      }),
    );
    expect(listens).toHaveLength(0);

    session.tapOrb();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    expect(audio.open).toHaveBeenCalledTimes(2);
    await session.stop();
  });

  it("does not listen when the screen closes while the microphone is opening", async () => {
    const { session, audio, listens } = harness();
    let grant!: () => void;
    vi.mocked(audio.open).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          grant = resolve;
        }),
    );
    session.start();
    await vi.waitFor(() => expect(audio.open).toHaveBeenCalled());
    const stopped = session.stop();
    grant();
    await stopped;
    await Promise.resolve();
    expect(audio.close).toHaveBeenCalled();
    expect(audio.listen).not.toHaveBeenCalled();
    expect(listens).toHaveLength(0);
  });

  it("does not start a reply that arrives after the turn was cancelled", async () => {
    const { session, audio, listens, playbacks } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    let ready!: () => void;
    vi.mocked(audio.play).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          const playback = { done: Promise.resolve("stopped" as const), stop: vi.fn() };
          playbacks.push({ finish: () => {}, stop: playback.stop });
          ready = () => resolve(playback);
        }),
    );
    listens[0]!.resolve(speech);
    await vi.waitFor(() => expect(audio.play).toHaveBeenCalled());
    const stopped = session.stop();
    ready();
    await stopped;
    await vi.waitFor(() => expect(playbacks[0]!.stop).toHaveBeenCalled());
  });

  it("shows a failed approval answer instead of rejecting", async () => {
    const { session, executeAction } = harness();
    session.start();
    executeAction.mockRejectedValueOnce(new Error("The action didn't go through."));
    await expect(
      session.respondToApproval(
        {
          environmentId: "env-1",
          threadId: "t1",
          threadTitle: "Fix the build",
          requestId: "r1",
          requestKind: "command",
          title: "Run tests",
          detail: null,
          reason: null,
        },
        "accept",
      ),
    ).resolves.toBeUndefined();
    expect(session.getSnapshot().error).toBe("The action didn't go through.");
    await session.stop();
  });

  it("releases the audio session on stop", async () => {
    const { session, audio, listens } = harness();
    session.start();
    await vi.waitFor(() => expect(listens).toHaveLength(1));
    await session.stop();
    expect(audio.close).toHaveBeenCalled();
    expect(listens[0]!.cancel).toHaveBeenCalled();
  });
});
