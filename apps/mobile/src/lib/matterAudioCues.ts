import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";

import {
  encodeMonoPcmWav,
  MATTR_AUDIO_CUE_SAMPLE_RATE,
  renderMattrAudioCuePcm,
  type MattrAudioCueId,
} from "../../../../antimatter/voice-assistant/audioCuesSynth";
import { disposeAudioPlayer } from "./audioSession";

export type { MattrAudioCueId };

const CUE_FILE_PREFIX = "mattr-audio-cue-v1";
const PLAYBACK_FAILSAFE_MS = 1_200;

const cachedCueUris = new Map<MattrAudioCueId, Promise<string | null>>();

export interface MobileAudioCuePreferences {
  readonly voiceSoundCuesEnabled?: boolean | undefined;
  readonly voiceThinkingCueEnabled?: boolean | undefined;
}

let preferencesReader: (() => MobileAudioCuePreferences | null) | null = null;

export function setMobileAudioCuePreferencesReader(
  reader: (() => MobileAudioCuePreferences | null) | null,
): void {
  preferencesReader = reader;
}

export function isMobileAudioCueEnabled(
  cue: MattrAudioCueId,
  preferences?: MobileAudioCuePreferences | null,
): boolean {
  const resolved = preferences ?? preferencesReader?.() ?? null;
  if (resolved?.voiceSoundCuesEnabled === false) return false;
  if (cue === "voice-mode-thinking" && resolved?.voiceThinkingCueEnabled === false) return false;
  return true;
}

async function ensureCueFileUri(cue: MattrAudioCueId): Promise<string | null> {
  const existing = cachedCueUris.get(cue);
  if (existing) return existing;

  const work = (async (): Promise<string | null> => {
    try {
      const file = new File(Paths.cache, `${CUE_FILE_PREFIX}-${cue}.wav`);
      const pcm = renderMattrAudioCuePcm(cue, MATTR_AUDIO_CUE_SAMPLE_RATE);
      const wav = encodeMonoPcmWav(pcm, MATTR_AUDIO_CUE_SAMPLE_RATE);
      file.create({ overwrite: true });
      await file.write(wav);
      return file.uri;
    } catch {
      cachedCueUris.delete(cue);
      return null;
    }
  })();

  cachedCueUris.set(cue, work);
  return work;
}

/**
 * Plays a short Lilt-family audio cue using `expo-audio` without modifying or deactivating
 * the active iOS/Android recording or Voice Mode audio session.
 * Never throws when audio hardware or Expo native modules are unavailable.
 */
export async function playMobileAudioCue(
  cue: MattrAudioCueId,
  options?: {
    readonly force?: boolean;
    readonly preferences?: MobileAudioCuePreferences | null;
  },
): Promise<boolean> {
  if (!options?.force && !isMobileAudioCueEnabled(cue, options?.preferences)) {
    return false;
  }

  const uri = await ensureCueFileUri(cue);
  if (!uri) return false;

  try {
    // Keep the shared audio session active so cue playback never steals or tears down
    // an active dictation recorder or Voice Mode playAndRecord session.
    const player = createAudioPlayer(
      { uri },
      { updateInterval: 100, keepAudioSessionActive: true },
    );
    let disposed = false;
    let failsafe: ReturnType<typeof setTimeout> | undefined;
    let subscription: { remove(): void } | undefined;

    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (failsafe !== undefined) clearTimeout(failsafe);
      subscription?.remove();
      try {
        disposeAudioPlayer(player);
      } catch {}
    };

    subscription = player.addListener?.("playbackStatusUpdate", (status) => {
      const error = (status as { readonly error?: unknown }).error;
      if (status.didJustFinish || (typeof error === "string" && error.length > 0)) {
        cleanup();
      }
    });
    failsafe = setTimeout(cleanup, PLAYBACK_FAILSAFE_MS);
    player.play();
    return true;
  } catch {
    return false;
  }
}

export function resetMobileAudioCuesForTests(): void {
  cachedCueUris.clear();
  preferencesReader = null;
}
