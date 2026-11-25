import {
  AudioModule,
  createAudioPlayer,
  RecordingPresets,
  requestRecordingPermissionsAsync,
  type AudioPlayer,
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
  audioExtensionForContentType,
  buildWavFile,
  createVoiceActivityDetector,
  type VoiceActivityConfig,
} from "./voiceAudioLogic";

const KEEP_AWAKE_TAG = "mattr-voice-mode";
const METERING_INTERVAL_MS = 60;
// A reply longer than this is a stuck player, not speech.
const MAX_PLAYBACK_MS = 6 * 60_000;

// The native constructor expects platform-flattened options, as built by useAudioRecorder.
const { ios: IOS_RECORDING_OPTIONS, android: ANDROID_RECORDING_OPTIONS } =
  RecordingPresets.HIGH_QUALITY;
const VOICE_RECORDING_OPTIONS = {
  extension: RecordingPresets.HIGH_QUALITY.extension,
  sampleRate: RecordingPresets.HIGH_QUALITY.sampleRate,
  numberOfChannels: RecordingPresets.HIGH_QUALITY.numberOfChannels,
  bitRate: RecordingPresets.HIGH_QUALITY.bitRate,
  isMeteringEnabled: true,
  ...(Platform.OS === "ios" ? IOS_RECORDING_OPTIONS : ANDROID_RECORDING_OPTIONS),
};

interface VoiceTranscriptionNative {
  decodeRecording?: (uri: string) => Promise<Uint8Array>;
  isAppleSpeechAvailable?: () => boolean;
  prepareAppleSpeech?: (locale: string) => Promise<string | null>;
  transcribeWithAppleSpeech?: (uri: string, locale: string) => Promise<string>;
}

const native = requireOptionalNativeModule<VoiceTranscriptionNative>("T3VoiceTranscription");

export const hasNativeVoiceCapture = typeof native?.decodeRecording === "function";

function deleteQuietly(uri: string | null) {
  if (!uri) return;
  try {
    new File(uri).delete();
  } catch {}
}

export type ListenResult =
  | { readonly kind: "utterance"; readonly uri: string; readonly heardSpeech: boolean }
  | { readonly kind: "no-speech" }
  | { readonly kind: "cancelled" };

export interface ListenOptions {
  readonly vad: VoiceActivityConfig;
  /** Normalized 0..1 microphone level, roughly every 60 ms. */
  readonly onLevel: (level: number) => void;
  readonly onSpeechStart: () => void;
}

export interface ActiveListening {
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
  private recorder: InstanceType<typeof AudioModule.AudioRecorder> | null = null;
  private opened = false;
  private fileSequence = 0;

  private opening: Promise<void> | null = null;

  /** Asks for the microphone, takes the shared audio session and keeps the screen awake. */
  open(): Promise<void> {
    if (this.opened) return Promise.resolve();
    this.opening ??= this.openOnce().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async openOnce(): Promise<void> {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error(m(msg("Microphone access is turned off for mattr.")));
    const token = acquireAudioSession("recording");
    this.token = token;
    try {
      const active = await activateAudioSession(token, {
        shouldPlayInBackground: true,
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
  }

  async close(): Promise<void> {
    if (!this.opened && !this.token) return;
    this.opened = false;
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
  }

  /** Records one utterance, ending on silence, `finish()` or `cancel()`. */
  async listen(options: ListenOptions): Promise<ActiveListening> {
    const recorder = (this.recorder ??= new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS));
    await recorder.prepareToRecordAsync();
    recorder.record();

    const detector = createVoiceActivityDetector(options.vad);
    let heardSpeech = false;
    let settled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let resolveResult: (result: ListenResult) => void = () => {};
    const result = new Promise<ListenResult>((resolve) => {
      resolveResult = resolve;
    });

    const end = async (reason: "keep" | "discard" | "no-speech") => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearInterval(timer);
      options.onLevel(0);
      try {
        await recorder.stop();
      } catch {}
      const uri = recorder.uri;
      if (reason === "keep" && uri) {
        resolveResult({ kind: "utterance", uri, heardSpeech });
        return;
      }
      deleteQuietly(uri);
      resolveResult(reason === "no-speech" ? { kind: "no-speech" } : { kind: "cancelled" });
    };

    timer = setInterval(() => {
      if (settled) return;
      let metering: number | undefined;
      try {
        const status = recorder.getStatus();
        if (status.mediaServicesDidReset) {
          void end("discard");
          return;
        }
        metering = status.metering;
      } catch {
        void end("discard");
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

  /**
   * Watches the microphone while the assistant talks and reports the moment the user speaks over
   * it. It records nothing the caller keeps: a barge-in starts a fresh `listen()`.
   */
  async watchForBargeIn(config: VoiceActivityConfig, onBargeIn: () => void) {
    const recorder = (this.recorder ??= new AudioModule.AudioRecorder(VOICE_RECORDING_OPTIONS));
    await recorder.prepareToRecordAsync();
    recorder.record();
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
  play(audio: SpokenAudio): ActivePlayback {
    const file = new File(
      Paths.cache,
      `mattr-voice-${Date.now()}-${++this.fileSequence}.${audioExtensionForContentType(audio.contentType)}`,
    );
    file.create({ overwrite: true });
    file.write(audio.bytes);

    let player: AudioPlayer | null = createAudioPlayer({ uri: file.uri }, { updateInterval: 100 });
    let ended = false;
    let finishWith: (outcome: "finished" | "stopped") => void = () => {};
    const done = new Promise<"finished" | "stopped">((resolve) => {
      finishWith = resolve;
    });
    const subscription = player.addListener("playbackStatusUpdate", (status) => {
      if (status.didJustFinish) end("finished");
    });
    const failsafe = setTimeout(() => end("stopped"), MAX_PLAYBACK_MS);

    function end(outcome: "finished" | "stopped") {
      if (ended) return;
      ended = true;
      clearTimeout(failsafe);
      subscription.remove();
      const current = player;
      player = null;
      if (current) disposeAudioPlayer(current);
      try {
        file.delete();
      } catch {}
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
        const current = player;
        if (current) pauseAudioPlayer(current);
        end("stopped");
      },
    };
  }

  /**
   * Server Deepgram first; on-device Apple Speech (iOS 26+) when the server has no speech
   * provider. The recording is deleted either way.
   */
  async transcribe(uri: string, api: VoiceAssistantApi, signal?: AbortSignal): Promise<string> {
    try {
      if (!native?.decodeRecording)
        throw new Error(m(msg("This build cannot read microphone audio.")));
      const pcm = await native.decodeRecording(uri);
      try {
        const response = await api.transcribe(buildWavFile(pcm), signal);
        return response.text.trim();
      } catch (error) {
        const unavailable =
          isVoiceAssistantApiError(error) && (error.unavailable || error.status === 502);
        if (!unavailable) throw error;
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
