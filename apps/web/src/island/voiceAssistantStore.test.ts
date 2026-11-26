import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_ISLAND_SETTINGS } from "../../../../antimatter/island/types";
import type {
  VoiceAssistantClientAction,
  VoiceAssistantTurnRequest,
  VoiceAssistantTurnResponse,
  VoiceBriefingRequest,
  VoiceBriefingResponse,
  VoiceSpeakRequest,
  VoiceWorkspaceApprovalSummary,
  VoiceWorkspaceContext,
} from "../../../../antimatter/voice-assistant/types";
import { DEFAULT_VOICE_ASSISTANT_SETTINGS } from "../../../../antimatter/voice-assistant/types";
import { updateIslandSettings, updateVoiceAssistantSettings } from "./islandSettingsStore";
import {
  applyThreadScopeToWorkspaceContext,
  bargeInVoiceAssistant as bargeIn,
  buildServerTtsPreferences,
  buildVoiceSpeakOptions,
  clearVoiceAssistantHistory as clearHistory,
  confirmsSpokenInterruption,
  getVoiceAssistantState,
  hasSustainedSpeech,
  openThreadVoiceMode,
  registerHostBridge,
  resetVoiceAssistantStoreForTests,
  setVoiceModeOpen,
  setVoiceAssistantMode as setMode,
  setVoiceAssistantScopedThread,
  submitQuickBriefing,
  submitVoiceAssistantUtterance as submitUtterance,
  syncVoiceTtsPreferencesToServer,
  toggleVoiceAssistantHandsFree,
  tryFastPathIntent,
  type VoiceChunkPlayer,
} from "./voiceAssistantStore";
import {
  createDeepgramFluxCapture,
  encodeWav16k,
  float32ToInt16Le,
  parseDeepgramFluxServerMessage,
  type DeepgramFluxCaptureOptions,
  type HandsFreeVadCaptureOptions,
  type VoiceTtsPlayer,
} from "./voiceModeAudio";

function makeApproval(
  overrides: Partial<VoiceWorkspaceApprovalSummary> = {},
): VoiceWorkspaceApprovalSummary {
  return {
    environmentId: "env-1",
    threadId: "thread-1",
    threadTitle: "Fix auth tests",
    requestId: "req-1",
    requestKind: "command",
    title: "Bash",
    detail: "pnpm test",
    reason: null,
    ...overrides,
  };
}

function makeContext(overrides: Partial<VoiceWorkspaceContext> = {}): VoiceWorkspaceContext {
  return {
    activeEnvironmentId: "env-1",
    activeThreadId: "thread-1",
    activeRoute: "/env-1/thread-1",
    mainWindowFocused: true,
    composerFocused: false,
    projects: [],
    threads: [],
    pendingApprovals: [],
    pendingQuestions: [],
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("tryFastPathIntent", () => {
  it("resolves single pending approval accept, always, session, and decline phrases", () => {
    const approval = makeApproval();
    const ctx = { pendingApprovals: [approval] };

    for (const phrase of ["approve", "Allow", "yes!", "go ahead please"]) {
      const intent = tryFastPathIntent(phrase, ctx);
      expect(intent?.kind).toBe("approval");
      if (intent?.kind === "approval") {
        expect(intent.decision).toBe("accept");
        expect(intent.action).toEqual({
          type: "respond-approval",
          environmentId: "env-1",
          threadId: "thread-1",
          requestId: "req-1",
          decision: "accept",
        });
        expect(intent.spokenReply).toBe("Approved.");
      }
    }

    const always = tryFastPathIntent("always allow", ctx);
    expect(always?.kind).toBe("approval");
    if (always?.kind === "approval") {
      expect(always.decision).toBe("acceptAlways");
    }

    const session = tryFastPathIntent("allow for session", ctx);
    expect(session?.kind).toBe("approval");
    if (session?.kind === "approval") {
      expect(session.decision).toBe("acceptForSession");
    }

    for (const phrase of ["deny", "reject", "no."]) {
      const denied = tryFastPathIntent(phrase, ctx);
      expect(denied?.kind).toBe("approval");
      if (denied?.kind === "approval") {
        expect(denied.decision).toBe("decline");
        expect(denied.spokenReply).toBe("Denied.");
      }
    }
  });

  it("falls through when zero or multiple approvals are pending, or when utterance has extra instructions", () => {
    expect(tryFastPathIntent("approve", { pendingApprovals: [] })).toBeNull();
    expect(
      tryFastPathIntent("approve", {
        pendingApprovals: [
          makeApproval({ requestId: "req-1" }),
          makeApproval({ requestId: "req-2" }),
        ],
      }),
    ).toBeNull();
    expect(
      tryFastPathIntent("approve it and then run the build", {
        pendingApprovals: [makeApproval()],
      }),
    ).toBeNull();
    expect(
      tryFastPathIntent("what threads are running right now?", {
        pendingApprovals: [makeApproval()],
      }),
    ).toBeNull();
  });

  it("recognizes pause/mute and cancel/stop talking commands", () => {
    expect(tryFastPathIntent("stop listening", { pendingApprovals: [] })?.kind).toBe(
      "pause-hands-free",
    );
    expect(tryFastPathIntent("pause voice mode", { pendingApprovals: [] })?.kind).toBe(
      "pause-hands-free",
    );
    expect(tryFastPathIntent("mute", { pendingApprovals: [] })?.kind).toBe("pause-hands-free");

    expect(tryFastPathIntent("cancel", { pendingApprovals: [] })?.kind).toBe("cancel-speech");
    expect(tryFastPathIntent("never mind", { pendingApprovals: [] })?.kind).toBe("cancel-speech");
    expect(tryFastPathIntent("stop talking", { pendingApprovals: [] })?.kind).toBe("cancel-speech");
  });
});

describe("voiceAssistantStore", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetVoiceAssistantStoreForTests();
  });

  afterEach(() => {
    resetVoiceAssistantStoreForTests();
  });

  it("executes a turn, runs returned clientActions, records sliding tool history, and speaks replies", async () => {
    const executedActions: VoiceAssistantClientAction[] = [];
    const spokenRequests: VoiceSpeakRequest[] = [];
    let capturedBody: VoiceAssistantTurnRequest | null = null;

    const fakeTts: VoiceTtsPlayer = {
      speak: async (req) => {
        spokenRequests.push(req);
      },
      stop: vi.fn(),
      isSpeaking: () => false,
    };

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body)) as VoiceAssistantTurnRequest;
      const reply: VoiceAssistantTurnResponse = {
        route: "assistant",
        spokenReply: "Opened the auth thread and started the test run.",
        displayReply: "Opened Fix auth tests.",
        expectFollowUp: false,
        toolResults: [
          {
            tool: "navigate_thread",
            ok: true,
            summary: "Opened Fix auth tests",
            environmentId: "env-1",
            threadId: "thread-1",
          },
        ],
        clientActions: [
          { type: "navigate-thread", environmentId: "env-1", threadId: "thread-1" },
          { type: "focus-window" },
        ],
      };
      return jsonResponse(reply);
    });

    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: (action) => {
        executedActions.push(action);
      },
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({
        baseUrl: "http://localhost:3773",
        headers: { Authorization: "Bearer test-token" },
      }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => fakeTts,
    });

    setVoiceModeOpen(true, { autoStartHandsFree: false });
    setMode("assistant");

    const response = await submitUtterance("open the auth thread");
    expect(response?.route).toBe("assistant");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(capturedBody).not.toBeNull();
    expect(capturedBody!.utterance).toBe("open the auth thread");
    expect(capturedBody!.mode).toBe("assistant");

    expect(executedActions).toEqual([
      { type: "navigate-thread", environmentId: "env-1", threadId: "thread-1" },
      { type: "focus-window" },
    ]);
    expect(spokenRequests).toHaveLength(1);
    expect(spokenRequests[0]?.text).toBe("Opened the auth thread and started the test run.");

    const state = getVoiceAssistantState();
    expect(state.phase).toBe("idle");
    expect(state.sessionOpen).toBe(true);
    expect(state.lastReply).toBe("Opened Fix auth tests.");
    expect(state.lastToolResults).toHaveLength(1);
    expect(state.recentTurns).toHaveLength(2);
    expect(state.recentTurns[0]?.role).toBe("user");
    expect(state.recentTurns[1]?.role).toBe("assistant");
    expect(state.recentTurns[1]?.toolResults).toHaveLength(1);

    clearHistory();
    expect(getVoiceAssistantState().recentTurns).toEqual([]);
  });

  it("handles single pending approval via fast-path without calling /turn", async () => {
    const executedActions: VoiceAssistantClientAction[] = [];
    const spokenRequests: VoiceSpeakRequest[] = [];
    const fetchMock = vi.fn();

    registerHostBridge({
      getWorkspaceContext: () => makeContext({ pendingApprovals: [makeApproval()] }),
      executeClientAction: (action) => {
        executedActions.push(action);
      },
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => ({
        speak: async (req) => {
          spokenRequests.push(req);
        },
        stop: vi.fn(),
        isSpeaking: () => false,
      }),
    });

    const result = await submitUtterance("approve");
    expect(result?.route).toBe("approval");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(executedActions).toEqual([
      {
        type: "respond-approval",
        environmentId: "env-1",
        threadId: "thread-1",
        requestId: "req-1",
        decision: "accept",
      },
    ]);
    expect(spokenRequests.map((s) => s.text)).toEqual(["Approved."]);
  });

  it("does not speak replies when server routes an utterance as dictation", async () => {
    const spokenRequests: VoiceSpeakRequest[] = [];
    const executedActions: VoiceAssistantClientAction[] = [];

    registerHostBridge({
      getWorkspaceContext: () => makeContext({ composerFocused: true }),
      executeClientAction: (action) => {
        executedActions.push(action);
      },
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: (async () =>
        jsonResponse({
          route: "dictation",
          spokenReply: "Inserted dictation.",
          displayReply: "Inserted dictation.",
          expectFollowUp: false,
          toolResults: [],
          clientActions: [{ type: "insert-dictation", text: "refactor the parser" }],
        } satisfies VoiceAssistantTurnResponse)) as unknown as typeof fetch,
      createTtsPlayer: () => ({
        speak: async (req) => {
          spokenRequests.push(req);
        },
        stop: vi.fn(),
        isSpeaking: () => false,
      }),
    });

    await submitUtterance("refactor the parser", { modeOverride: "smart" });
    expect(executedActions).toEqual([{ type: "insert-dictation", text: "refactor the parser" }]);
    expect(spokenRequests).toHaveLength(0);
  });

  it("drains proactive briefings politely in priority order (approval > question > failed/limited > completed)", async () => {
    const spokenOrder: string[] = [];
    const firstTurnGate = Promise.withResolvers<void>();
    const allSpokenGate = Promise.withResolvers<void>();

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/turn") || url.endsWith("/turn-stream")) {
        await firstTurnGate.promise;
        return jsonResponse({
          route: "direct-reply",
          spokenReply: "Done checking.",
          displayReply: "Done checking.",
          expectFollowUp: false,
          toolResults: [],
          clientActions: [],
        } satisfies VoiceAssistantTurnResponse);
      }
      const req = JSON.parse(String(init?.body)) as VoiceBriefingRequest;
      return jsonResponse({
        spokenText: `${req.kind}:${req.threadTitle}`,
        shortLabel: `${req.kind} - ${req.threadTitle}`,
        expectFollowUp: req.kind === "approval" || req.kind === "question",
      } satisfies VoiceBriefingResponse);
    });

    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: () => undefined,
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => ({
        speak: async (req) => {
          spokenOrder.push(req.text);
          if (spokenOrder.length === 5) {
            allSpokenGate.resolve();
          }
        },
        stop: vi.fn(),
        isSpeaking: () => false,
      }),
    });

    // Start a user turn so briefings must queue politely while the turn is active.
    const turnPromise = submitUtterance("status update");
    await Promise.resolve();

    submitQuickBriefing({
      kind: "completed",
      threadTitle: "Build docs",
      projectTitle: "mattr",
      detail: null,
      latestAssistantMessage: null,
    });
    submitQuickBriefing({
      kind: "failed",
      threadTitle: "Run migrations",
      projectTitle: "mattr",
      detail: "exit 1",
      latestAssistantMessage: null,
    });
    submitQuickBriefing({
      kind: "question",
      threadTitle: "Refactor router",
      projectTitle: "mattr",
      detail: "Choose strategy",
      latestAssistantMessage: null,
    });
    submitQuickBriefing({
      kind: "approval",
      threadTitle: "Deploy staging",
      projectTitle: "mattr",
      detail: "rm -rf dist",
      latestAssistantMessage: null,
    });

    expect(getVoiceAssistantState().pendingBriefingCount).toBe(4);
    expect(spokenOrder).toEqual([]);

    firstTurnGate.resolve();
    await turnPromise;
    await allSpokenGate.promise;

    expect(spokenOrder).toEqual([
      "Done checking.",
      "approval:Deploy staging",
      "question:Refactor router",
      "failed:Run migrations",
      "completed:Build docs",
    ]);

    const briefingTurns = getVoiceAssistantState().recentTurns.filter((t) => t.role === "briefing");
    expect(briefingTurns.map((t) => t.text)).toEqual([
      "approval:Deploy staging",
      "question:Refactor router",
      "failed:Run migrations",
      "completed:Build docs",
    ]);
  });

  it("stops active TTS immediately on bargeIn", () => {
    const stopSpy = vi.fn();
    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: () => undefined,
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      createTtsPlayer: () => ({
        speak: () => new Promise<void>(() => {}),
        stop: stopSpy,
        isSpeaking: () => true,
      }),
    });

    void submitUtterance("hello");
    bargeIn();
    expect(getVoiceAssistantState().speaking).toBe(false);
    expect(getVoiceAssistantState().phase).toBe("idle");
  });
});

describe("ElevenLabs TTS preferences", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetVoiceAssistantStoreForTests();
  });

  afterEach(() => {
    resetVoiceAssistantStoreForTests();
  });

  it("builds provider-specific speak options for ElevenLabs, auto, and Deepgram", () => {
    expect(
      buildVoiceSpeakOptions({
        ...DEFAULT_VOICE_ASSISTANT_SETTINGS,
        ttsProvider: "elevenlabs",
        ttsVoice: "aura-2-luna-en",
        elevenlabsVoice: "EXAVITQu4vr4xnSDxMaL",
        elevenlabsModel: "eleven_flash_v2_5",
        elevenlabsCustomVoiceId: "CustomVoiceOverride1234",
        elevenlabsStyle: 0.35,
      }),
    ).toEqual({
      provider: "elevenlabs",
      voice: "CustomVoiceOverride1234",
      model: "eleven_flash_v2_5",
      speed: 1.08,
      elevenlabsVoiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0.35,
        speed: 1,
        useSpeakerBoost: true,
      },
    });
    expect(buildVoiceSpeakOptions(DEFAULT_VOICE_ASSISTANT_SETTINGS)).toEqual({
      provider: "auto",
      model: "eleven_v4_turbo",
      speed: 1.08,
      elevenlabsVoiceSettings: {
        stability: 0.5,
        similarityBoost: 0.75,
        style: 0.15,
        speed: 1,
        useSpeakerBoost: true,
      },
    });
    expect(
      buildVoiceSpeakOptions({
        ...DEFAULT_VOICE_ASSISTANT_SETTINGS,
        ttsProvider: "deepgram",
        ttsVoice: "aura-2-luna-en",
      }),
    ).toEqual({ provider: "deepgram", voice: "aura-2-luna-en", speed: 1.08 });
  });

  it("builds server preferences without clobbering the Deepgram voice for other engines", () => {
    expect(
      buildServerTtsPreferences({
        ...DEFAULT_VOICE_ASSISTANT_SETTINGS,
        ttsProvider: "deepgram",
        ttsVoice: "aura-2-orion-en",
      }),
    ).toEqual({
      ttsProvider: "deepgram",
      elevenlabsModel: "eleven_v4_turbo",
      elevenlabsVoice: "SAz9YHcvj6GT2YYXdXww",
      deepgramVoice: "aura-2-orion-en",
      customVoiceId: "",
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0.15,
      speed: 1,
      useSpeakerBoost: true,
    });
    expect(
      buildServerTtsPreferences({
        ...DEFAULT_VOICE_ASSISTANT_SETTINGS,
        ttsProvider: "openai",
        ttsVoice: "coral",
      }),
    ).not.toHaveProperty("deepgramVoice");
  });

  it("posts TTS preferences to the server config endpoint and tolerates failures", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
      jsonResponse(JSON.parse(String(init?.body))),
    );
    const settings = updateVoiceAssistantSettings({
      ttsProvider: "elevenlabs",
      elevenlabsVoice: "cgSgspJ2msm6clMCkdW9",
      elevenlabsModel: "eleven_v4",
    }).voiceAssistant;

    const saved = await syncVoiceTtsPreferencesToServer(
      { baseUrl: "http://localhost:3773/", headers: { authorization: "Bearer t" } },
      settings,
      fetchMock as unknown as typeof fetch,
    );
    expect(saved).toEqual({
      ttsProvider: "elevenlabs",
      elevenlabsModel: "eleven_v4",
      elevenlabsVoice: "cgSgspJ2msm6clMCkdW9",
      customVoiceId: "",
      stability: 0.5,
      similarityBoost: 0.75,
      style: 0.15,
      speed: 1,
      useSpeakerBoost: true,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("http://localhost:3773/api/mattr/voice-assistant/config");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer t");

    const failing = vi.fn(async () => jsonResponse({ error: "nope" }, 500));
    await expect(
      syncVoiceTtsPreferencesToServer(
        { baseUrl: "http://localhost:3773" },
        settings,
        failing as unknown as typeof fetch,
      ),
    ).resolves.toBeNull();
    const throwing = vi.fn(async () => {
      throw new TypeError("offline");
    });
    await expect(
      syncVoiceTtsPreferencesToServer(
        { baseUrl: "http://localhost:3773" },
        settings,
        throwing as unknown as typeof fetch,
      ),
    ).resolves.toBeNull();
  });

  it("speaks assistant replies with the selected ElevenLabs voice and model", async () => {
    const spokenRequests: VoiceSpeakRequest[] = [];
    updateVoiceAssistantSettings({
      ttsProvider: "elevenlabs",
      elevenlabsVoice: "XrExE9yKIg1WjnnlVkGX",
      elevenlabsModel: "eleven_v3_conversational",
    });
    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: () => undefined,
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: (async () =>
        jsonResponse({
          route: "assistant",
          spokenReply: "All three threads are green.",
          displayReply: "All green.",
          expectFollowUp: false,
          toolResults: [],
          clientActions: [],
        } satisfies VoiceAssistantTurnResponse)) as unknown as typeof fetch,
      createTtsPlayer: () => ({
        speak: async (req) => {
          spokenRequests.push(req);
        },
        stop: vi.fn(),
        isSpeaking: () => false,
      }),
    });

    setMode("assistant");
    await submitUtterance("how are my threads doing");
    expect(spokenRequests).toEqual([
      {
        text: "All three threads are green.",
        provider: "elevenlabs",
        voice: "XrExE9yKIg1WjnnlVkGX",
        model: "eleven_v3_conversational",
        speed: 1.08,
        elevenlabsVoiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.15,
          speed: 1,
          useSpeakerBoost: true,
        },
      },
    ]);
  });
});

describe("encodeWav16k", () => {
  it("encodes 16 kHz mono 16-bit PCM WAV with valid RIFF/WAVE header", async () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const blob = encodeWav16k(pcm);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(44 + pcm.length * 2);

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);
    const header = String.fromCharCode(...bytes.slice(0, 4));
    const format = String.fromCharCode(...bytes.slice(8, 12));
    expect(header).toBe("RIFF");
    expect(format).toBe("WAVE");
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // Mono
    expect(view.getUint32(24, true)).toBe(16_000); // 16 kHz
    expect(view.getUint16(34, true)).toBe(16); // 16-bit
    expect(view.getUint32(40, true)).toBe(pcm.length * 2);
  });
});

describe("Deepgram Flux streaming STT", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetVoiceAssistantStoreForTests();
  });

  afterEach(() => {
    resetVoiceAssistantStoreForTests();
  });

  it("parses Flux TurnInfo events and encodes linear16 Int16 PCM", () => {
    expect(
      parseDeepgramFluxServerMessage(JSON.stringify({ type: "Connected", request_id: "r1" })),
    ).toEqual({ type: "Connected", request_id: "r1" });
    expect(
      parseDeepgramFluxServerMessage(
        JSON.stringify({ type: "TurnInfo", event: "StartOfTurn", transcript: "" }),
      ),
    ).toEqual({ type: "TurnInfo", event: "StartOfTurn", transcript: "" });
    expect(
      parseDeepgramFluxServerMessage(
        JSON.stringify({ type: "TurnInfo", event: "Update", transcript: "check the" }),
      ),
    ).toEqual({ type: "TurnInfo", event: "Update", transcript: "check the" });
    expect(
      parseDeepgramFluxServerMessage(
        JSON.stringify({
          type: "TurnInfo",
          event: "EndOfTurn",
          transcript: "check the build",
          end_of_turn_confidence: 0.89,
        }),
      ),
    ).toEqual({
      type: "TurnInfo",
      event: "EndOfTurn",
      transcript: "check the build",
      end_of_turn_confidence: 0.89,
    });
    expect(parseDeepgramFluxServerMessage("{bad json")).toBeNull();

    const bytes = float32ToInt16Le(new Float32Array([0, 1, -1]));
    const view = new DataView(bytes.buffer);
    expect(bytes.byteLength).toBe(6);
    expect(view.getInt16(0, true)).toBe(0);
    expect(view.getInt16(2, true)).toBe(32767);
    expect(view.getInt16(4, true)).toBe(-32768);
  });

  it("falls back cleanly to VAD when Flux WS closes with 4401 deepgram_not_configured", async () => {
    const constructedUrls: string[] = [];
    const fallbackReasons: string[] = [];

    class MockClosedWebSocket {
      binaryType = "blob";
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: { readonly data: unknown }) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null = null;

      constructor(url: string) {
        constructedUrls.push(url);
        queueMicrotask(() => {
          this.readyState = 3;
          this.onclose?.({ code: 4401, reason: "deepgram_not_configured" });
        });
      }

      send(): void {}
      close(): void {
        this.readyState = 3;
      }
    }

    const fetchMock = vi.fn(async () => jsonResponse({ ticket: "media-ticket-123" }));

    const capture = createDeepgramFluxCapture({
      getApiConfig: () => ({
        baseUrl: "https://mac.tailnet.ts.net:3773",
        headers: { Authorization: "Bearer session-token" },
      }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      webSocketImpl: MockClosedWebSocket as unknown as typeof WebSocket,
      onLevel: () => undefined,
      onSpeechStart: () => undefined,
      onLiveTranscript: () => undefined,
      onFinalTranscript: () => undefined,
      onFallbackToVad: (reason) => {
        fallbackReasons.push(reason);
      },
      onError: () => undefined,
    });

    await capture.start();

    expect(constructedUrls).toEqual([
      "wss://mac.tailnet.ts.net:3773/api/mattr/voice-assistant/flux?wsTicket=media-ticket-123",
    ]);
    expect(fallbackReasons).toEqual(["deepgram_not_configured"]);
    expect(capture.isActive()).toBe(false);
  });

  it("streams live transcripts, barges in on StartOfTurn, and submits EndOfTurn directly without transcribePcm", async () => {
    let fluxOptions: DeepgramFluxCaptureOptions | null = null;
    const transcribePcmMock = vi.fn(async () => "should not be called");
    const stopTtsSpy = vi.fn();
    const submittedUtterances: string[] = [];
    const turnDone = Promise.withResolvers<void>();

    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as VoiceAssistantTurnRequest;
      submittedUtterances.push(body.utterance);
      queueMicrotask(() => turnDone.resolve());
      return jsonResponse({
        route: "direct-reply",
        spokenReply: "All checks are green.",
        displayReply: "All checks are green.",
        expectFollowUp: false,
        toolResults: [],
        clientActions: [],
      } satisfies VoiceAssistantTurnResponse);
    });

    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: () => undefined,
      transcribePcm: transcribePcmMock,
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => ({
        speak: () => new Promise<void>(() => {}),
        stop: stopTtsSpy,
        isSpeaking: () => true,
      }),
      createFluxCapture: (opts) => {
        fluxOptions = opts;
        let running = false;
        return {
          start: async () => {
            running = true;
          },
          stop: () => {
            running = false;
          },
          setMuted: () => undefined,
          setSpeakingDuck: () => undefined,
          isActive: () => running,
        };
      },
    });

    toggleVoiceAssistantHandsFree();
    await Promise.resolve();
    expect(fluxOptions).not.toBeNull();
    expect(getVoiceAssistantState().handsFreeActive).toBe(true);

    // Simulate StartOfTurn + streaming Update + EndOfTurn
    fluxOptions!.onSpeechStart();
    fluxOptions!.onLiveTranscript("how is the");
    expect(getVoiceAssistantState().liveTranscript).toBe("how is the");

    fluxOptions!.onLiveTranscript("how is the build looking");
    expect(getVoiceAssistantState().liveTranscript).toBe("how is the build looking");

    fluxOptions!.onFinalTranscript("how is the build looking");
    await turnDone.promise;

    expect(transcribePcmMock).not.toHaveBeenCalled();
    expect(submittedUtterances).toEqual(["how is the build looking"]);
  });

  it("falls back seamlessly from Flux to VAD capture in voiceAssistantStore", async () => {
    let fluxOptions: DeepgramFluxCaptureOptions | null = null;
    let vadOptions: HandsFreeVadCaptureOptions | null = null;
    let vadStarted = false;
    const transcribePcmMock = vi.fn(async () => "open settings");
    const turnDone = Promise.withResolvers<void>();

    const fetchMock = vi.fn(async () => {
      queueMicrotask(() => turnDone.resolve());
      return jsonResponse({
        route: "direct-reply",
        spokenReply: "Opened settings.",
        displayReply: "Opened settings.",
        expectFollowUp: false,
        toolResults: [],
        clientActions: [],
      } satisfies VoiceAssistantTurnResponse);
    });

    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: () => undefined,
      transcribePcm: transcribePcmMock,
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => ({
        speak: async () => undefined,
        stop: vi.fn(),
        isSpeaking: () => false,
      }),
      createFluxCapture: (opts) => {
        fluxOptions = opts;
        return {
          start: async () => {
            opts.onFallbackToVad("deepgram_not_configured");
          },
          stop: () => undefined,
          setMuted: () => undefined,
          setSpeakingDuck: () => undefined,
          isActive: () => false,
        };
      },
      createVadCapture: (opts) => {
        vadOptions = opts;
        return {
          start: async () => {
            vadStarted = true;
          },
          stop: () => {
            vadStarted = false;
          },
          setMuted: () => undefined,
          setSpeakingDuck: () => undefined,
          isActive: () => vadStarted,
        };
      },
    });

    toggleVoiceAssistantHandsFree();
    await vi.waitFor(() => expect(vadStarted).toBe(true));

    expect(fluxOptions).not.toBeNull();
    expect(vadOptions).not.toBeNull();
    expect(getVoiceAssistantState().handsFreeActive).toBe(true);
    expect(getVoiceAssistantState().error).toBeNull();

    vadOptions!.onUtterance(new Float32Array([0.1, -0.1, 0.2]), 16000);
    await turnDone.promise;

    expect(transcribePcmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function ndjsonResponse(events: ReadonlyArray<unknown>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // Split mid-line to prove lines are reassembled across reads.
      const text = events.map((event) => `${JSON.stringify(event)}\n`).join("");
      const middle = Math.floor(text.length / 2);
      controller.enqueue(encoder.encode(text.slice(0, middle)));
      controller.enqueue(encoder.encode(text.slice(middle)));
      controller.close();
    },
  });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
}

function audioChunk(seq: number, text: string) {
  return {
    type: "audio_chunk",
    seq,
    text,
    contentType: "audio/mpeg",
    audioBase64: btoa(text),
    provider: "deepgram",
  };
}

function doneEvent(reply: string, actions: ReadonlyArray<VoiceAssistantClientAction> = []) {
  return {
    type: "done",
    reply,
    displayReply: reply,
    route: "assistant",
    expectFollowUp: false,
    actions,
    toolCalls: [],
  };
}

interface FakeChunkPlayer extends VoiceChunkPlayer {
  readonly chunks: string[];
  ended: boolean;
  readonly pause: ReturnType<typeof vi.fn<() => void>>;
  readonly resume: ReturnType<typeof vi.fn<() => void>>;
  readonly stop: ReturnType<typeof vi.fn<() => void>>;
  finish(): void;
}

function fakeChunkPlayers() {
  const players: FakeChunkPlayer[] = [];
  const create = (): VoiceChunkPlayer => {
    const { promise, resolve } = Promise.withResolvers<"finished" | "stopped">();
    const player: FakeChunkPlayer = {
      done: promise,
      chunks: [],
      ended: false,
      enqueue: (bytes) => {
        player.chunks.push(new TextDecoder().decode(bytes));
      },
      end: () => {
        player.ended = true;
      },
      pause: vi.fn<() => void>(),
      resume: vi.fn<() => void>(),
      stop: vi.fn<() => void>(() => resolve("stopped")),
      finish: () => resolve("finished"),
    };
    players.push(player);
    return player;
  };
  return { players, create };
}

function silentTts() {
  const speak = vi.fn(async (_req: VoiceSpeakRequest) => undefined);
  return { speak, player: { speak, stop: vi.fn(), isSpeaking: () => false } };
}

describe("streamed voice turns", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetVoiceAssistantStoreForTests();
  });

  afterEach(() => {
    resetVoiceAssistantStoreForTests();
  });

  it("plays streamed sentences in order and runs tool actions once, as soon as they arrive", async () => {
    const { players, create } = fakeChunkPlayers();
    const tts = silentTts();
    const executed: VoiceAssistantClientAction[] = [];
    const action: VoiceAssistantClientAction = { type: "focus-window" };
    let body: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:3773/api/mattr/voice-assistant/turn-stream");
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ndjsonResponse([
        { type: "tool_result", toolCalls: [], actions: [action] },
        { type: "text_delta", text: "First one. " },
        audioChunk(0, "First one."),
        audioChunk(1, "Second one."),
        doneEvent("First one. Second one.", [action]),
      ]);
    });
    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: (next) => {
        executed.push(next);
      },
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => tts.player,
      createChunkPlayer: create,
    });
    setMode("assistant");

    const turn = submitUtterance("focus the window");
    await vi.waitFor(() => expect(players[0]?.ended).toBe(true));
    expect(players[0]!.chunks).toEqual(["First one.", "Second one."]);
    expect(getVoiceAssistantState().speaking).toBe(true);
    expect(body).toMatchObject({ utterance: "focus the window", speak: { provider: "auto" } });

    players[0]!.finish();
    const response = await turn;
    expect(response?.spokenReply).toBe("First one. Second one.");
    expect(executed).toEqual([action]);
    expect(tts.speak).not.toHaveBeenCalled();
    expect(getVoiceAssistantState().speaking).toBe(false);
    expect(getVoiceAssistantState().phase).toBe("idle");
  });

  it("falls back to /turn plus /speak on servers without the stream, and remembers it", async () => {
    const tts = silentTts();
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/turn-stream")) return new Response("Not Found", { status: 404 });
      return jsonResponse({
        route: "assistant",
        spokenReply: "Done.",
        displayReply: "Done.",
        expectFollowUp: false,
        toolResults: [],
        clientActions: [],
      } satisfies VoiceAssistantTurnResponse);
    });
    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: () => undefined,
      transcribePcm: async () => "",
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => tts.player,
      createChunkPlayer: () => {
        throw new Error("no audio streams from an old server");
      },
    });
    setMode("assistant");

    await submitUtterance("status");
    await submitUtterance("status again");
    expect(
      urls.map((url) => url.replace("http://localhost:3773/api/mattr/voice-assistant", "")),
    ).toEqual(["/turn-stream", "/turn", "/turn"]);
    expect(tts.speak.mock.calls.map(([req]) => req.text)).toEqual(["Done.", "Done."]);
  });
});

describe("voice barge-in guard", () => {
  beforeEach(() => {
    updateIslandSettings(DEFAULT_ISLAND_SETTINGS);
    resetVoiceAssistantStoreForTests();
  });

  afterEach(() => {
    resetVoiceAssistantStoreForTests();
  });

  it("needs two words or a command word to confirm an interruption", () => {
    expect(confirmsSpokenInterruption("")).toBe(false);
    expect(confirmsSpokenInterruption("um")).toBe(false);
    expect(confirmsSpokenInterruption("Stop!")).toBe(true);
    expect(confirmsSpokenInterruption("hold on")).toBe(true);
    expect(confirmsSpokenInterruption("actually no")).toBe(true);
  });

  it("rejects short transients but accepts sustained speech in captured audio", () => {
    const clip = (voicedMs: number) => {
      const pcm = new Float32Array(16_000);
      for (let index = 0; index < (voicedMs / 1000) * 16_000; index += 1) {
        pcm[index] = Math.sin(index / 5) * 0.3;
      }
      return pcm;
    };
    expect(hasSustainedSpeech(clip(150))).toBe(false);
    expect(hasSustainedSpeech(clip(240))).toBe(false);
    expect(hasSustainedSpeech(clip(600))).toBe(true);
  });

  function startStreamedReply(options: { readonly flux: boolean }) {
    const { players, create } = fakeChunkPlayers();
    const utterances: string[] = [];
    const transcribePcm = vi.fn(async () => "actually check the tests");
    let fluxOptions: DeepgramFluxCaptureOptions | null = null;
    let vadOptions: HandsFreeVadCaptureOptions | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as VoiceAssistantTurnRequest;
      utterances.push(body.utterance);
      return ndjsonResponse([
        audioChunk(0, "Here is a long answer."),
        doneEvent("Here is a long answer."),
      ]);
    });
    const capture = () => ({
      start: async () => undefined,
      stop: () => undefined,
      setMuted: () => undefined,
      setSpeakingDuck: () => undefined,
      isActive: () => true,
    });
    registerHostBridge({
      getWorkspaceContext: () => makeContext(),
      executeClientAction: () => undefined,
      transcribePcm,
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773" }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => silentTts().player,
      createChunkPlayer: create,
      ...(options.flux
        ? {
            createFluxCapture: (opts: DeepgramFluxCaptureOptions) => {
              fluxOptions = opts;
              return capture();
            },
          }
        : {
            createVadCapture: (opts: HandsFreeVadCaptureOptions) => {
              vadOptions = opts;
              return capture();
            },
          }),
    });
    toggleVoiceAssistantHandsFree();
    return {
      players,
      utterances,
      transcribePcm,
      flux: () => fluxOptions!,
      vad: () => vadOptions!,
      speakFirstTurn: async (say: () => void) => {
        say();
        await vi.waitFor(() => expect(getVoiceAssistantState().speaking).toBe(true));
        return players[0]!;
      },
    };
  }

  it("Flux StartOfTurn with no words pauses the reply, then resumes it in place", async () => {
    const harness = startStreamedReply({ flux: true });
    await vi.waitFor(() => expect(harness.flux()).not.toBeNull());
    const reply = await harness.speakFirstTurn(() =>
      harness.flux().onFinalTranscript("how is the build"),
    );

    harness.flux().onSpeechStart();
    expect(reply.pause).toHaveBeenCalledTimes(1);
    harness.flux().onLiveTranscript("um");
    await vi.waitFor(() => expect(reply.resume).toHaveBeenCalledTimes(1), { timeout: 2_500 });
    expect(reply.stop).not.toHaveBeenCalled();
    expect(getVoiceAssistantState().speaking).toBe(true);
    // A filler-only end of turn is not a new request.
    harness.flux().onFinalTranscript("um");
    expect(harness.utterances).toEqual(["how is the build"]);
  });

  it("two words cut the reply and the same Flux turn becomes the next request", async () => {
    const harness = startStreamedReply({ flux: true });
    await vi.waitFor(() => expect(harness.flux()).not.toBeNull());
    const reply = await harness.speakFirstTurn(() =>
      harness.flux().onFinalTranscript("how is the build"),
    );

    harness.flux().onSpeechStart();
    harness.flux().onLiveTranscript("actually");
    expect(reply.stop).not.toHaveBeenCalled();
    harness.flux().onLiveTranscript("actually check");
    expect(reply.stop).toHaveBeenCalledTimes(1);
    expect(getVoiceAssistantState().speaking).toBe(false);
    expect(getVoiceAssistantState().liveTranscript).toBe("actually check");

    harness.flux().onFinalTranscript("actually check the tests");
    await vi.waitFor(() =>
      expect(harness.utterances).toEqual(["how is the build", "actually check the tests"]),
    );
  });

  it('a single "stop" interrupts at once', async () => {
    const harness = startStreamedReply({ flux: true });
    await vi.waitFor(() => expect(harness.flux()).not.toBeNull());
    const reply = await harness.speakFirstTurn(() =>
      harness.flux().onFinalTranscript("how is the build"),
    );
    harness.flux().onLiveTranscript("stop");
    expect(reply.stop).toHaveBeenCalledTimes(1);
  });

  it("local VAD: a car-door spike pauses, never interrupts; sustained speech does", async () => {
    const harness = startStreamedReply({ flux: false });
    await vi.waitFor(() => expect(harness.vad()).not.toBeNull());
    const reply = await harness.speakFirstTurn(() => {
      void submitUtterance("how is the build", { modeOverride: "voice-mode" });
    });

    const spike = new Float32Array(16_000);
    for (let index = 0; index < 2_400; index += 1) spike[index] = index % 2 === 0 ? 0.8 : -0.8;
    harness.vad().onSpeechStart();
    expect(reply.pause).toHaveBeenCalledTimes(1);
    harness.vad().onUtterance(spike, 16_000);
    await vi.waitFor(() => expect(reply.resume).toHaveBeenCalledTimes(1));
    expect(harness.transcribePcm).not.toHaveBeenCalled();
    expect(reply.stop).not.toHaveBeenCalled();

    const speech = new Float32Array(16_000);
    for (let index = 0; index < 9_600; index += 1) speech[index] = Math.sin(index / 5) * 0.3;
    harness.vad().onSpeechStart();
    harness.vad().onUtterance(speech, 16_000);
    await vi.waitFor(() =>
      expect(harness.utterances).toEqual(["how is the build", "actually check the tests"]),
    );
    expect(reply.stop).toHaveBeenCalledTimes(1);
  });
});

describe("in-thread voice mode scoping", () => {
  beforeEach(() => {
    resetVoiceAssistantStoreForTests();
  });

  afterEach(() => {
    resetVoiceAssistantStoreForTests();
  });

  it("applyThreadScopeToWorkspaceContext overrides activeThreadId and synthesizes missing thread entries", () => {
    const base = makeContext({
      activeEnvironmentId: "env-1",
      activeThreadId: "thread-1",
      threads: [
        {
          environmentId: "env-1",
          threadId: "thread-1",
          title: "Other thread",
          projectId: null,
          projectTitle: null,
          status: "running",
          updatedAt: "2026-11-25T10:00:00.000Z",
          latestUserMessage: null,
          latestAssistantMessage: null,
          isActive: true,
        },
      ],
    });

    const scoped = applyThreadScopeToWorkspaceContext(base, {
      environmentId: "env-2",
      threadId: "thread-99",
      title: "Antimatter setup check",
    });

    expect(scoped.activeEnvironmentId).toBe("env-2");
    expect(scoped.activeThreadId).toBe("thread-99");
    expect(scoped.threads[0]).toMatchObject({
      environmentId: "env-2",
      threadId: "thread-99",
      title: "Antimatter setup check",
      isActive: true,
    });
    expect(scoped.threads[1]?.isActive).toBe(false);
  });

  it("openThreadVoiceMode opens modal scoped to the thread, sends scoped activeThreadId on turns, and resets cleanly for global mode", async () => {
    const requests: VoiceAssistantTurnRequest[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        requests.push(JSON.parse(init.body) as VoiceAssistantTurnRequest);
      }
      return jsonResponse({
        route: "assistant",
        spokenReply: "Looking at that thread now.",
        displayReply: "Looking at that thread now.",
        expectFollowUp: true,
        toolResults: [],
        clientActions: [],
      } satisfies VoiceAssistantTurnResponse);
    });
    const fakePlayer: VoiceTtsPlayer = {
      speak: vi.fn(async () => {}),
      stop: vi.fn(),
      isSpeaking: () => false,
    };

    registerHostBridge({
      getWorkspaceContext: () =>
        makeContext({
          activeEnvironmentId: "env-1",
          activeThreadId: "thread-1",
        }),
      executeClientAction: vi.fn(),
      transcribePcm: vi.fn(async () => ""),
      getApiBaseUrlAndHeaders: () => ({ baseUrl: "http://localhost:3773", headers: {} }),
      fetchImpl: fetchMock as unknown as typeof fetch,
      createTtsPlayer: () => fakePlayer,
    });

    openThreadVoiceMode(
      {
        environmentId: "env-2",
        threadId: "thread-77",
        title: "Antimatter setup check",
      },
      { autoStartHandsFree: false },
    );

    expect(getVoiceAssistantState()).toMatchObject({
      sessionOpen: true,
      mode: "voice-mode",
      scopedThread: {
        environmentId: "env-2",
        threadId: "thread-77",
        title: "Antimatter setup check",
      },
      originThread: {
        environmentId: "env-2",
        threadId: "thread-77",
        title: "Antimatter setup check",
      },
    });

    await submitUtterance("What is happening here?");
    expect(requests[0]?.context.activeEnvironmentId).toBe("env-2");
    expect(requests[0]?.context.activeThreadId).toBe("thread-77");
    expect(requests[0]?.context.threads[0]?.isActive).toBe(true);

    // Switching to All workspace clears active thread scope override but keeps originThread reversible.
    setVoiceAssistantScopedThread(null);
    expect(getVoiceAssistantState().scopedThread).toBeNull();
    expect(getVoiceAssistantState().originThread?.threadId).toBe("thread-77");

    await submitUtterance("What else is running?");
    expect(requests[1]?.context.activeEnvironmentId).toBe("env-1");
    expect(requests[1]?.context.activeThreadId).toBe("thread-1");

    // Switching to a different thread clears stale turns from the prior thread conversation.
    openThreadVoiceMode(
      {
        environmentId: "env-1",
        threadId: "thread-88",
        title: "Another thread",
      },
      { autoStartHandsFree: false },
    );
    expect(getVoiceAssistantState().recentTurns).toEqual([]);
    expect(getVoiceAssistantState().scopedThread?.threadId).toBe("thread-88");

    // Global entry points open in the chat on screen.
    setVoiceModeOpen(false);
    setVoiceModeOpen(true, { autoStartHandsFree: false });
    expect(getVoiceAssistantState().scopedThread?.threadId).toBe("thread-1");
    expect(getVoiceAssistantState().originThread?.threadId).toBe("thread-1");
  });
});
