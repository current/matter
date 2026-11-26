/** The Matter Flux proxy closes with this when the server has no Deepgram key. */
export const FLUX_NOT_CONFIGURED_CLOSE_CODE = 4401;
const FLUX_CONNECT_TIMEOUT_MS = 5_000;
// After a tap to send, Flux gets this long to finalize the words it already heard.
const FLUX_FINISH_GRACE_MS = 800;
// About two seconds of 80 ms chunks, so the first words survive the socket handshake.
const FLUX_MAX_BUFFERED_CHUNKS = 25;

export type FluxTurnEvent =
  | "StartOfTurn"
  | "Update"
  | "EagerEndOfTurn"
  | "TurnResumed"
  | "EndOfTurn";

export type FluxServerMessage =
  | { readonly type: "Connected" }
  | { readonly type: "TurnInfo"; readonly event: FluxTurnEvent; readonly transcript: string }
  | { readonly type: "Error"; readonly description: string | null };

const TURN_EVENTS: ReadonlySet<string> = new Set<FluxTurnEvent>([
  "StartOfTurn",
  "Update",
  "EagerEndOfTurn",
  "TurnResumed",
  "EndOfTurn",
]);

export function parseFluxMessage(raw: unknown): FluxServerMessage | null {
  if (typeof raw !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as Record<string, unknown>;
  if (message.type === "Connected") return { type: "Connected" };
  if (
    message.type === "TurnInfo" &&
    typeof message.event === "string" &&
    TURN_EVENTS.has(message.event)
  ) {
    return {
      type: "TurnInfo",
      event: message.event as FluxTurnEvent,
      transcript: typeof message.transcript === "string" ? message.transcript.trim() : "",
    };
  }
  if (message.type === "Error") {
    return {
      type: "Error",
      description: typeof message.description === "string" ? message.description : null,
    };
  }
  return null;
}

/** One ~80 ms slice of 16 kHz mono Int16 PCM and its 0..1 RMS amplitude. */
export interface PcmChunk {
  readonly bytes: Uint8Array;
  readonly level: number;
}

/** A running microphone tap; `subscribe` returns the unsubscribe. */
export interface PcmFeed {
  subscribe(onChunk: (chunk: PcmChunk) => void): () => void;
}

/** The parts of a browser/React Native WebSocket the client uses. */
export interface FluxSocket {
  send(data: ArrayBuffer | string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  onerror: (() => void) | null;
  onclose: ((event: { readonly code: number }) => void) | null;
}

export type StreamingListenResult =
  | { readonly kind: "utterance"; readonly text: string; readonly heardSpeech: boolean }
  | { readonly kind: "no-speech" }
  | { readonly kind: "cancelled" }
  /** Flux could not serve this turn; `permanent` when the server has no Deepgram key. */
  | { readonly kind: "unavailable"; readonly permanent: boolean };

export interface StreamingListenOptions {
  /** Normalized 0..1 microphone level for every chunk. */
  readonly onLevel: (level: number) => void;
  readonly onSpeechStart: () => void;
  /** The words heard so far in this turn, as Flux refines them. */
  readonly onTranscript: (text: string) => void;
  /** Maps the raw RMS amplitude to the level shown on screen. */
  readonly normalizeLevel?: (rms: number) => number;
}

export interface ActiveStreamingListening {
  readonly result: Promise<StreamingListenResult>;
  /** Sends what was heard so far now (tap to send). */
  finish(): void;
  cancel(): void;
}

const SOCKET_OPEN = 1;

function chunkBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

/**
 * Streams the microphone to Deepgram Flux through the server proxy for one user turn. Flux
 * decides the end of the turn semantically (~260 ms after the last word), so the reply starts
 * without the fixed silence wait of local endpointing.
 */
export function listenWithFlux(input: {
  readonly url: string;
  readonly feed: PcmFeed;
  readonly options: StreamingListenOptions;
  readonly createSocket?: (url: string) => FluxSocket;
  readonly connectTimeoutMs?: number;
}): ActiveStreamingListening {
  const { options } = input;
  const normalize = options.normalizeLevel ?? ((rms: number) => rms);
  const socket = (input.createSocket ?? ((url) => new WebSocket(url) as unknown as FluxSocket))(
    input.url,
  );
  let settled = false;
  let opened = false;
  let connected = false;
  let heardSpeech = false;
  let latest = "";
  let buffered: Uint8Array[] = [];
  let finishTimer: ReturnType<typeof setTimeout> | null = null;
  let settle: (result: StreamingListenResult) => void = () => {};
  const result = new Promise<StreamingListenResult>((resolve) => {
    settle = resolve;
  });

  const end = (outcome: StreamingListenResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(connectTimer);
    if (finishTimer !== null) clearTimeout(finishTimer);
    unsubscribe();
    buffered = [];
    options.onLevel(0);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
      socket.close(1000);
    } catch {}
    settle(outcome);
  };
  const heardSoFar = (): StreamingListenResult =>
    latest.length > 0
      ? { kind: "utterance", text: latest, heardSpeech: true }
      : connected
        ? { kind: "no-speech" }
        : { kind: "unavailable", permanent: false };

  const connectTimer = setTimeout(() => {
    if (!opened) end({ kind: "unavailable", permanent: false });
  }, input.connectTimeoutMs ?? FLUX_CONNECT_TIMEOUT_MS);

  const unsubscribe = input.feed.subscribe((chunk) => {
    if (settled) return;
    options.onLevel(normalize(chunk.level));
    if (!opened) {
      buffered.push(chunk.bytes);
      if (buffered.length > FLUX_MAX_BUFFERED_CHUNKS) buffered.shift();
      return;
    }
    try {
      socket.send(chunkBuffer(chunk.bytes));
    } catch {
      end(heardSoFar());
    }
  });

  socket.onopen = () => {
    if (settled) return;
    opened = true;
    clearTimeout(connectTimer);
    const pending = buffered;
    buffered = [];
    try {
      for (const bytes of pending) socket.send(chunkBuffer(bytes));
    } catch {
      end({ kind: "unavailable", permanent: false });
    }
  };

  socket.onmessage = (event) => {
    if (settled) return;
    const message = parseFluxMessage(event.data);
    if (!message) return;
    if (message.type === "Connected") {
      connected = true;
      return;
    }
    if (message.type === "Error") {
      end(heardSoFar());
      return;
    }
    connected = true;
    if (message.event === "StartOfTurn" || (!heardSpeech && message.transcript.length > 0)) {
      if (!heardSpeech) {
        heardSpeech = true;
        options.onSpeechStart();
      }
    }
    if (message.transcript.length > 0 && message.transcript !== latest) {
      latest = message.transcript;
      options.onTranscript(latest);
    }
    if (message.event === "EndOfTurn") {
      if (latest.length > 0) end({ kind: "utterance", text: latest, heardSpeech: true });
      else heardSpeech = false;
    }
  };

  socket.onerror = () => {
    end(heardSoFar());
  };

  socket.onclose = (event) => {
    if (event.code === FLUX_NOT_CONFIGURED_CLOSE_CODE) {
      end({ kind: "unavailable", permanent: true });
      return;
    }
    end(heardSoFar());
  };

  return {
    result,
    finish: () => {
      if (settled) return;
      if (!heardSpeech || !opened) {
        end({ kind: "utterance", text: latest, heardSpeech });
        return;
      }
      // Flux finalizes the words it already heard when the stream closes.
      try {
        socket.send(JSON.stringify({ type: "CloseStream" }));
      } catch {}
      finishTimer ??= setTimeout(
        () => end({ kind: "utterance", text: latest, heardSpeech }),
        FLUX_FINISH_GRACE_MS,
      );
    },
    cancel: () => end({ kind: "cancelled" }),
  };
}
