import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  FLUX_NOT_CONFIGURED_CLOSE_CODE,
  listenWithFlux,
  parseFluxMessage,
  type FluxSocket,
  type PcmChunk,
} from "./fluxListening";

function fakeSocket() {
  const sent: Array<ArrayBuffer | string> = [];
  const socket: FluxSocket & { sent: typeof sent; closed: number | null } = {
    sent,
    closed: null,
    readyState: 0,
    send: (data) => {
      sent.push(data);
    },
    close: (code) => {
      socket.closed = code ?? 1000;
    },
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
  };
  return {
    socket,
    open: () => {
      (socket as { readyState: number }).readyState = 1;
      socket.onopen?.();
    },
    receive: (message: object) => socket.onmessage?.({ data: JSON.stringify(message) }),
    turn: (event: string, transcript = "") =>
      socket.onmessage?.({ data: JSON.stringify({ type: "TurnInfo", event, transcript }) }),
  };
}

function fakeFeed() {
  let subscriber: ((chunk: PcmChunk) => void) | null = null;
  return {
    feed: {
      subscribe: (next: (chunk: PcmChunk) => void) => {
        subscriber = next;
        return () => {
          subscriber = null;
        };
      },
    },
    push: (byte: number, level = 0.1) => subscriber?.({ bytes: new Uint8Array([byte]), level }),
    get subscribed() {
      return subscriber !== null;
    },
  };
}

function start() {
  const fake = fakeSocket();
  const mic = fakeFeed();
  const callbacks = { onLevel: vi.fn(), onSpeechStart: vi.fn(), onTranscript: vi.fn() };
  const listening = listenWithFlux({
    url: "wss://mac.example/api/mattr/voice-assistant/flux?wsTicket=t",
    feed: mic.feed,
    options: callbacks,
    createSocket: () => fake.socket,
  });
  return { ...fake, mic, callbacks, listening };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("parseFluxMessage", () => {
  it("reads turn events and ignores anything else", () => {
    expect(
      parseFluxMessage(JSON.stringify({ type: "TurnInfo", event: "Update", transcript: " hi " })),
    ).toEqual({ type: "TurnInfo", event: "Update", transcript: "hi" });
    expect(parseFluxMessage(JSON.stringify({ type: "TurnInfo", event: "Other" }))).toBeNull();
    expect(parseFluxMessage("not json")).toBeNull();
    expect(parseFluxMessage(new ArrayBuffer(2))).toBeNull();
  });
});

describe("listenWithFlux", () => {
  it("sends the words Flux heard when it ends the turn", async () => {
    const { open, receive, turn, socket, mic, callbacks, listening } = start();
    mic.push(1);
    mic.push(2);
    expect(socket.sent).toHaveLength(0);
    open();
    // Audio captured during the handshake goes out first, in order.
    expect(socket.sent.map((data) => new Uint8Array(data as ArrayBuffer)[0])).toEqual([1, 2]);
    receive({ type: "Connected" });

    turn("StartOfTurn");
    expect(callbacks.onSpeechStart).toHaveBeenCalledTimes(1);
    turn("Update", "what's");
    turn("Update", "what's running");
    expect(callbacks.onTranscript).toHaveBeenLastCalledWith("what's running");
    turn("EndOfTurn", "what's running");

    await expect(listening.result).resolves.toEqual({
      kind: "utterance",
      text: "what's running",
      heardSpeech: true,
    });
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "CloseStream" }));
    expect(socket.closed).toBe(1000);
    expect(mic.subscribed).toBe(false);
  });

  it("reports a server without Deepgram as permanently unavailable", async () => {
    const { socket, listening } = start();
    socket.onclose?.({ code: FLUX_NOT_CONFIGURED_CLOSE_CODE });
    await expect(listening.result).resolves.toEqual({ kind: "unavailable", permanent: true });
  });

  it("falls back when the socket never connects", async () => {
    vi.useFakeTimers();
    const { listening } = start();
    vi.advanceTimersByTime(5_000);
    await expect(listening.result).resolves.toEqual({ kind: "unavailable", permanent: false });
  });

  it("listens again when the stream ends without words", async () => {
    const { open, receive, socket, listening } = start();
    open();
    receive({ type: "Connected" });
    socket.onclose?.({ code: 1000 });
    await expect(listening.result).resolves.toEqual({ kind: "no-speech" });
  });

  it("keeps the words already heard when the stream drops", async () => {
    const { open, turn, socket, listening } = start();
    open();
    turn("Update", "approve it");
    socket.onclose?.({ code: 4502 });
    await expect(listening.result).resolves.toMatchObject({
      kind: "utterance",
      text: "approve it",
    });
  });

  it("a tap before anyone spoke ends with no words", async () => {
    const { open, listening } = start();
    open();
    listening.finish();
    await expect(listening.result).resolves.toEqual({
      kind: "utterance",
      text: "",
      heardSpeech: false,
    });
  });

  it("a tap mid-sentence asks Flux to finalize, then sends", async () => {
    vi.useFakeTimers();
    const { open, turn, socket, listening } = start();
    open();
    turn("StartOfTurn");
    turn("Update", "open the");
    listening.finish();
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "CloseStream" }));
    turn("EndOfTurn", "open the build thread");
    await expect(listening.result).resolves.toMatchObject({ text: "open the build thread" });
  });

  it("cancel discards the turn", async () => {
    const { open, turn, listening } = start();
    open();
    turn("Update", "never mind");
    listening.cancel();
    await expect(listening.result).resolves.toEqual({ kind: "cancelled" });
  });
});
