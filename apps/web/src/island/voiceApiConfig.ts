import { matterFetchCredentials } from "../addons/matterApi";
import type { VoiceTtsApiConfig } from "./voiceModeAudio";

interface VoiceApiConnection {
  readonly httpBaseUrl?: string | null;
  readonly httpAuthorization?:
    | { readonly _tag: "Bearer"; readonly token: string }
    | { readonly _tag: "Dpop"; readonly accessToken: string }
    | null;
}

/** Where the primary environment's `/api/mattr/voice-assistant/*` routes live, and how to authenticate. */
export function buildVoiceApiConfig(
  prepared: VoiceApiConnection | null,
  fallbackOrigin: string,
): Required<VoiceTtsApiConfig> {
  const rawBase = prepared?.httpBaseUrl?.trim();
  const baseUrl = rawBase && rawBase.length > 0 ? rawBase.replace(/\/+$/, "") : fallbackOrigin;
  const headers: Record<string, string> = {};
  if (prepared?.httpAuthorization?._tag === "Bearer") {
    headers.authorization = `Bearer ${prepared.httpAuthorization.token}`;
  } else if (prepared?.httpAuthorization?._tag === "Dpop") {
    headers.authorization = `Bearer ${prepared.httpAuthorization.accessToken}`;
  }
  return { baseUrl, headers, credentials: matterFetchCredentials(headers) };
}
