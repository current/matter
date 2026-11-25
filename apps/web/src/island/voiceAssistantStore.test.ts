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
import { updateIslandSettings } from "./islandSettingsStore";
import {
  bargeInVoiceAssistant as bargeIn,
  clearVoiceAssistantHistory as clearHistory,
  getVoiceAssistantState,
  registerHostBridge,
  resetVoiceAssistantStoreForTests,
  setVoiceAssistantModalOpen as setModalOpen,
  setVoiceAssistantMode as setMode,
  submitQuickBriefing,
  submitVoiceAssistantUtterance as submitUtterance,
  toggleVoiceAssistantHandsFree,
  tryFastPathIntent,
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

    setMode("assistant");
    setModalOpen(true);

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
    expect(state.modalOpen).toBe(true);
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
      if (url.endsWith("/turn")) {
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
