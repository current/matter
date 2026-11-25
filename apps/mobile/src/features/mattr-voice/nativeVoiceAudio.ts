import {
  AudioModule,
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type AudioStatus,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import { requireOptionalNativeModule } from "expo";
import { msg } from "gt-react-native";
import { Platform } from "react-native";

import { m } from "../../i18n/messages";
import {
  acquireAudioSession,
  activateAudioSession,
  disposeAudioPlayer,
  pauseAudioPlayer,
  releaseAudioSession,
} from "../../lib/audioSession";
import { normalizeVoiceInputDecibels } from "../voice-input/voiceInputMetering";
import {
  isVoiceAssistantApiError,
  type SpokenAudio,
  type VoiceAssistantApi,
} from "./voiceAssistantApi";
import {
  listenWithFlux,
  type ActiveStreamingListening,
  type PcmChunk,
  type PcmFeed,
  type StreamingListenOptions,
} from "./fluxListening";
import {
  audioExtensionForContentType,
  BARGE_IN_ECHO_CANCELLED_VAD,
  buildWavFile,
  createVoiceActivityDetector,
  rmsToDecibels,
  type VoiceActivityConfig,
} from "./voiceAudioLogic";

const KEEP_AWAKE_TAG = "mattr-voice-mode";
const METERING_INTERVAL_MS = 60;
// A recorder that is still not running this long after record() was stopped by the system
// (a phone call, Siri, another app taking the microphone).
const RECORDING_START_GRACE_MS = 600;
// A reply whose file has not loaded by then is not going to play.
const PLAYBACK_LOAD_TIMEOUT_MS = 15_000;
const PLAYBACK_END_SLACK_MS = 5_000;
// A reply longer than this is a stuck player, not speech.
const MAX_PLAYBACK_MS = 6 * 60_000;
// The longest utterance kept in memory when recording from the live microphone stream.
const MAX_PCM_UTTERANCE_BYTES = 16_000 * 2 * 120;

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
// Speech is decoded to 16 kHz mono before upload, so a second channel only costs disk and CPU.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
// The platform preset goes first: it carries its own channel count and bit rate, and metering
// off, which would silently disable voice activity detection.
const VOICE_RECORDING_OPTIONS = {
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: 1,
  bitRate: 64_000,
  isMeteringEnabled: true,
};

type Recorder = InstanceType<typeof AudioModule.AudioRecorder>;

interface VoiceTranscriptionNative {
  decodeRecording?: (uri: string) => Promise<Uint8Array>;
  isAppleSpeechAvailable?: () => boolean;
  prepareAppleSpeech?: (locale: string) => Promise<string | null>;
  transcribeWithAppleSpeech?: (uri: string, locale: string) => Promise<string>;
  startPcmStream?: () => Promise<{ readonly voiceProcessing: boolean }>;
  stopPcmStream?: () => Promise<void>;
  addListener?: (
    event: "onPcmChunk",
    listener: (event: { readonly data: string; readonly level: number }) => void,
  ) => { remove(): void };
}

const native = requireOptionalNativeModule<VoiceTranscriptionNative>("T3VoiceTranscription");

function deleteQuietly(uri: string | null) {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {}
}

/** Expo reports a failed load as an `error` key that its status type does not declare. */
function playbackError(status: AudioStatus): boolean {
  const { error } = status as AudioStatus & { readonly error?: unknown };
  return typeof error === "string" && error.length > 0;
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/** The live microphone tap (iOS `AVAudioEngine` with voice processing), shared by every consumer. */
class NativePcmFeed implements PcmFeed {
  private readonly subscribers = new Set<(chunk: PcmChunk) => void>();
  private subscription: { remove(): void } | null = null;
  private starting: Promise<{ readonly voiceProcessing: boolean }> | null = null;

  static get supported() {
    return Boolean(native?.startPcmStream && native.stopPcmStream && native.addListener);
  }

  start(): Promise<{ readonly voiceProcessing: boolean }> {
    if (this.starting) return this.starting;
    const { startPcmStream, addListener } = native ?? {};
    if (!startPcmStream || !addListener) {
      return Promise.reject(new Error("Live microphone streaming is not available."));
    }
    this.subscription = addListener("onPcmChunk", (event) => {
      if (this.subscribers.size === 0) return;
      const chunk = { bytes: decodeBase64(event.data), level: event.level };
      for (const subscriber of this.subscribers) subscriber(chunk);
    });
    const starting = startPcmStream();
    this.starting = starting;
    starting.catch(() => {
      if (this.starting === starting) void this.stop();
    });
    return starting;
  }

  async stop() {
    this.starting = null;
    this.subscription?.remove();
    this.subscription = null;
    this.subscribers.clear();
    await native?.stopPcmStream?.().catch(() => {});
  }

  subscribe(onChunk: (chunk: PcmChunk) => void) {
    this.subscribers.add(onChunk);
    return () => {
      this.subscribers.delete(onChunk);
    };
  }
}

const pcmLevel = (rms: number) => normalizeVoiceInputDecibels(rmsToDecibels(rms));

/** A finished utterance: a recorder file, or 16 kHz mono PCM from the live stream. */
export type VoiceRecording = { readonly uri: string } | { readonly pcm: Uint8Array };

export type ListenResult =
  | {
      readonly kind: "utterance";
      readonly recording: VoiceRecording;
      readonly heardSpeech: boolean;
    }
  | { readonly kind: "no-speech" }
  | { readonly kind: "cancelled" };

export interface ListenOptions {
  readonly vad: VoiceActivityConfig;
  /** Normalized 0..1 microphone level, roughly every 60 ms. */
  readonly onLevel: (level: number) => void;
  readonly onSpeechStart: () => void;
}

export interface ActiveListening {
  /** Rejects when the system takes the microphone away mid-recording. */
  readonly result: Promise<ListenResult>;
  /** Ends the recording now and keeps it (tap to send). */
  finish(): void;
  /** Ends the recording now and throws the audio away. */
  cancel(): void;
}

export interface ActivePlayback {
  /** Settles when playback ends naturally or is stopped. */
  readonly done: Promise<"finished" | "stopped">;
  /** Stops at once; the audio session stays active for the next recording. */
  stop(): void;
}

/**
 * Microphone and speaker for hands-free voice mode. One long-lived `playAndRecord` session
 * (Bluetooth and CarPlay routes, background audio) serves both directions, so the car's route
 * never drops between a question and its answer.
 */
export class NativeVoiceAudio {
  private token: ReturnType<typeof acquireAudioSession> | null = null;
  private recorder: Recorder | null = null;
  private pcmFeed: NativePcmFeed | null = null;
  /** Set after the live stream failed to start, so later turns go straight to the recorder. */
  private pcmFailed = false;
  private voiceProcessing = false;
  private opened = false;
  private fileSequence = 0;
  // open() and close() run one at a time, so a screen that closes while the permission
  // prompt is up cannot leave the session, or the screen, awake.
  private lifecycle: Promise<void> = Promise.resolve();

  private serialize(operation: () => Promise<void>): Promise<void> {
    const next = this.lifecycle.then(operation);
    this.lifecycle = next.catch(() => {});
    return next;
  }

  /** Asks for the microphone, takes the shared audio session and keeps the screen awake. */
  open(): Promise<void> {
    return this.serialize(async () => {
      if (this.opened) return;
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error(m(msg("Microphone access is turned off for mattr.")));
      }
      const token = acquireAudioSession("recording");
      this.token = token;
      try {
        const active = await activateAudioSession(token, {
          keepAliveInBackground: true,
          shouldRouteThroughEarpiece: false,
        });
        if (!active) throw new Error(m(msg("Another audio session is using the microphone.")));
      } catch (error) {
        this.token = null;
        await releaseAudioSession(token).catch(() => {});
        throw error;
      }
      this.opened = true;
      void activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    });
  }

  close(): Promise<void> {
    return this.serialize(async () => {
      if (!this.opened && !this.token) return;
      this.opened = false;
      const feed = this.pcmFeed;
      this.pcmFeed = null;
      await feed?.stop();
      const recorder = this.recorder;
      this.recorder = null;
      if (recorder) {
        try {
          await recorder.stop();
        } catch {}
        deleteQuietly(recorder.uri);
        recorder.release();
      }
      void Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => {});
      const token = this.token;
      this.token = null;
      if (token) await releaseAudioSession(token).catch(() => {});
    });
  }

  private async startRecorder(): Promise<Recorder> {
    if (!this.opened) throw new Error(m(msg("Voice mode isn't listening right now.")));
    const recorder = (this.recorder ??= new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS));
    await recorder.prepareToRecordAsync();
    recorder.record();
    return recorder;
  }

  /** A reset media server invalidates every recorder; the next recording builds a new one. */
  private dropRecorder(recorder: Recorder) {
    if (this.recorder !== recorder) return;
    this.recorder = null;
    try {
      recorder.release();
    } catch {}
  }

  /**
   * The live microphone stream, started once per voice session and kept running across turns so
   * echo cancellation stays settled. Null where the native tap is missing (Android, older builds).
   */
  private async livePcm(): Promise<NativePcmFeed | null> {
    if (!this.opened) throw new Error(m(msg("Voice mode isn't listening right now.")));
    if (this.pcmFailed || !NativePcmFeed.supported) return null;
    const feed = (this.pcmFeed ??= new NativePcmFeed());
    try {
      this.voiceProcessing = (await feed.start()).voiceProcessing;
      return feed;
    } catch {
      this.pcmFailed = true;
      if (this.pcmFeed === feed) this.pcmFeed = null;
      await feed.stop();
      return null;
    }
  }

  /**
   * Streams one turn to Deepgram Flux for semantic end-of-turn and live words. Null when this
   * device has no live microphone stream; the caller then records with `listen()`.
   */
  async listenStreaming(
    api: VoiceAssistantApi,
    options: StreamingListenOptions,
  ): Promise<ActiveStreamingListening | null> {
    const feed = await this.livePcm();
    if (!feed) return null;
    const url = await api.fluxSocketUrl();
    return listenWithFlux({ url, feed, options: { ...options, normalizeLevel: pcmLevel } });
  }

  /** Records one utterance, ending on silence, `finish()` or `cancel()`. */
  async listen(options: ListenOptions): Promise<ActiveListening> {
    const feed = await this.livePcm();
    if (feed) return this.listenToFeed(feed, options);
    const recorder = await this.startRecorder();
    const startedAt = Date.now();
    const detector = createVoiceActivityDetector(options.vad);
    let heardSpeech = false;
    let settled = false;
    let settle: (outcome: ListenResult | Error) => void = () => {};
    const result = new Promise<ListenResult>((resolve, reject) => {
      settle = (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome));
    });

    const end = async (reason: "keep" | "discard" | "no-speech" | Error) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      options.onLevel(0);
      try {
        await recorder.stop();
      } catch {}
      const uri = recorder.uri;
      if (reason === "keep" && uri) {
        settle({ kind: "utterance", recording: { uri }, heardSpeech });
        return;
      }
      deleteQuietly(uri);
      if (reason instanceof Error) settle(reason);
      else settle(reason === "no-speech" ? { kind: "no-speech" } : { kind: "cancelled" });
    };
    const interrupted = () =>
      new Error(m(msg("The microphone was interrupted. Voice mode will listen again.")));

    const timer = setInterval(() => {
      if (settled) return;
      let metering: number | undefined;
      try {
        const status = recorder.getStatus();
        if (status.mediaServicesDidReset) {
          this.dropRecorder(recorder);
          void end(interrupted());
          return;
        }
        if (!status.isRecording && Date.now() - startedAt > RECORDING_START_GRACE_MS) {
          void end(interrupted());
          return;
        }
        metering = status.metering;
      } catch {
        void end(interrupted());
        return;
      }
      options.onLevel(normalizeVoiceInputDecibels(metering));
      const event = detector.push(metering, Date.now());
      if (event === "speech-start") {
        heardSpeech = true;
        options.onSpeechStart();
      } else if (event === "end-of-speech" || event === "max-duration") {
        void end("keep");
      } else if (event === "no-speech-timeout") {
        void end("no-speech");
      }
    }, METERING_INTERVAL_MS);

    return {
      result,
      finish: () => void end("keep"),
      cancel: () => void end("discard"),
    };
  }

  /** Local endpointing over the live stream, keeping the PCM for `/transcribe`. */
  private listenToFeed(feed: PcmFeed, options: ListenOptions): ActiveListening {
    const detector = createVoiceActivityDetector(options.vad);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let heardSpeech = false;
    let settled = false;
    let settle: (outcome: ListenResult) => void = () => {};
    const result = new Promise<ListenResult>((resolve) => {
      settle = resolve;
    });
    const end = (reason: "keep" | "discard" | "no-speech") => {
      if (settled) return;
      settled = true;
      unsubscribe();
      options.onLevel(0);
      if (reason !== "keep") {
        settle(reason === "no-speech" ? { kind: "no-speech" } : { kind: "cancelled" });
        return;
      }
      const pcm = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        pcm.set(chunk, offset);
        offset += chunk.byteLength;
      }
      settle({ kind: "utterance", recording: { pcm }, heardSpeech });
    };
    const unsubscribe = feed.subscribe((chunk) => {
      if (settled) return;
      options.onLevel(pcmLevel(chunk.level));
      if (size + chunk.bytes.byteLength <= MAX_PCM_UTTERANCE_BYTES) {
        chunks.push(chunk.bytes);
        size += chunk.bytes.byteLength;
      }
      const event = detector.push(rmsToDecibels(chunk.level), Date.now());
      if (event === "speech-start") {
        heardSpeech = true;
        options.onSpeechStart();
      } else if (event === "end-of-speech" || event === "max-duration") {
        end("keep");
      } else if (event === "no-speech-timeout") {
        end("no-speech");
      }
    });
    return { result, finish: () => end("keep"), cancel: () => end("discard") };
  }

  /** Deletes a recording the caller decided not to transcribe. */
  discardRecording(recording: VoiceRecording) {
    if ("uri" in recording) deleteQuietly(recording.uri);
  }

  /**
   * Watches the microphone while the assistant talks and reports the moment the user speaks over
   * it. It records nothing the caller keeps: a barge-in starts a fresh `listen()`.
   */
  async watchForBargeIn(config: VoiceActivityConfig, onBargeIn: () => void) {
    const feed = await this.livePcm();
    if (feed) {
      // With the reply cancelled out of the microphone, normal speech is enough to interrupt.
      const detector = createVoiceActivityDetector(
        this.voiceProcessing ? BARGE_IN_ECHO_CANCELLED_VAD : config,
      );
      let fired = false;
      const unsubscribe = feed.subscribe((chunk) => {
        if (fired) return;
        if (detector.push(rmsToDecibels(chunk.level), Date.now()) === "speech-start") {
          fired = true;
          onBargeIn();
        }
      });
      return async () => unsubscribe();
    }
    const recorder = await this.startRecorder();
    const detector = createVoiceActivityDetector(config);
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped) return;
      try {
        const event = detector.push(recorder.getStatus().metering, Date.now());
        if (event === "speech-start") onBargeIn();
      } catch {}
    }, METERING_INTERVAL_MS);
    return async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        await recorder.stop();
      } catch {}
      deleteQuietly(recorder.uri);
    };
  }

  /** Plays reply audio from the server; `stop()` interrupts it immediately. */
  async play(audio: SpokenAudio): Promise<ActivePlayback> {
    const file = new File(
      Paths.cache,
      `mattr-voice-${Date.now()}-${++this.fileSequence}.${audioExtensionForContentType(audio.contentType)}`,
    );
    try {
      file.create({ overwrite: true });
      // Async since Expo SDK 58: the player must not open a half-written file.
      await file.write(audio.bytes);
    } catch (error) {
      deleteQuietly(file.uri);
      throw error;
    }

    // The voice session owns the audio session; the player must never deactivate it.
    const player = createAudioPlayer(
      { uri: file.uri },
      { updateInterval: 100, keepAudioSessionActive: true },
    );
    let ended = false;
    let finishWith: (outcome: "finished" | "stopped") => void = () => {};
    const done = new Promise<"finished" | "stopped">((resolve) => {
      finishWith = resolve;
    });
    let failsafe = setTimeout(() => end("stopped"), PLAYBACK_LOAD_TIMEOUT_MS);
    let durationKnown = false;
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) {
        end("finished");
      } else if (playbackError(status)) {
        end("stopped");
      } else if (!durationKnown && status.isLoaded) {
        durationKnown = true;
        clearTimeout(failsafe);
        const expectedMs =
          Number.isFinite(status.duration) && status.duration > 0
            ? status.duration * 1000 + PLAYBACK_END_SLACK_MS
            : MAX_PLAYBACK_MS;
        failsafe = setTimeout(() => end("stopped"), Math.min(expectedMs, MAX_PLAYBACK_MS));
      }
    });

    function end(outcome: "finished" | "stopped") {
      if (ended) return;
      ended = true;
      clearTimeout(failsafe);
      subscription.remove();
      disposeAudioPlayer(player);
      deleteQuietly(file.uri);
      finishWith(outcome);
    }

    try {
      player.play();
    } catch (error) {
      end("stopped");
      throw error;
    }
    return {
      done,
      stop: () => {
        if (ended) return;
        pauseAudioPlayer(player);
        end("stopped");
      },
    };
  }

  /**
   * Server Deepgram first; on-device Apple Speech (iOS 26+) when the server has no speech
   * provider. The recording is deleted either way.
   */
  async transcribe(
    recording: VoiceRecording,
    api: VoiceAssistantApi,
    signal?: AbortSignal,
  ): Promise<string> {
    let uri = "uri" in recording ? recording.uri : null;
    try {
      let pcm: Uint8Array;
      if ("pcm" in recording) {
        pcm = recording.pcm;
      } else {
        if (!native?.decodeRecording)
          throw new Error(m(msg("This build cannot read microphone audio.")));
        pcm = await native.decodeRecording(recording.uri);
      }
      const wav = buildWavFile(pcm);
      try {
        const response = await api.transcribe(wav, signal);
        return response.text.trim();
      } catch (error) {
        const unavailable =
          isVoiceAssistantApiError(error) && (error.unavailable || error.status === 502);
        if (!unavailable || signal?.aborted) throw error;
        if (uri === null) {
          const file = new File(
            Paths.cache,
            `mattr-voice-${Date.now()}-${++this.fileSequence}.wav`,
          );
          file.create({ overwrite: true });
          await file.write(wav);
          uri = file.uri;
        }
        return await this.transcribeOnDevice(uri);
      }
    } finally {
      deleteQuietly(uri);
    }
  }

  private async transcribeOnDevice(uri: string): Promise<string> {
    if (
      !native?.isAppleSpeechAvailable?.() ||
      !native.prepareAppleSpeech ||
      !native.transcribeWithAppleSpeech
    ) {
      throw new Error(
        m(msg("Speech recognition isn't set up on this server. Add a Deepgram key.")),
      );
    }
    const locale = await native.prepareAppleSpeech(Intl.DateTimeFormat().resolvedOptions().locale);
    if (locale === null)
      throw new Error(m(msg("On-device speech recognition doesn't support this language.")));
    return (await native.transcribeWithAppleSpeech(uri, locale)).trim();
  }
}
