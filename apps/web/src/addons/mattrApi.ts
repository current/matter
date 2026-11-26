import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { usePreparedConnection } from "../state/session";
import { usePrimaryEnvironmentId } from "../state/environments";

/** Where the primary environment's `/api/mattr/*` routes live, and how to authenticate. */
export interface MattrApiConfig {
  readonly baseUrl: string;
  readonly headers: Readonly<Record<string, string>>;
}

export function useMattrApiConfig(): MattrApiConfig | null {
  const environmentId = usePrimaryEnvironmentId();
  const prepared = Option.getOrNull(usePreparedConnection(environmentId));
  if (!prepared) return null;
  const rawBase = prepared.httpBaseUrl?.trim();
  const baseUrl =
    rawBase && rawBase.length > 0 ? rawBase.replace(/\/+$/, "") : window.location.origin;
  const authorization = prepared.httpAuthorization;
  const bearer =
    authorization?._tag === "Bearer"
      ? authorization.token
      : authorization?._tag === "Dpop"
        ? authorization.accessToken
        : null;
  return internConfig(baseUrl, bearer);
}

/**
 * Packaged servers answer CORS with a non-credentialed `*`, so a credentialed cross-origin fetch
 * (the desktop renderer at t3code://app) fails preflight. Only cookie auth needs credentials.
 */
export function mattrFetchCredentials(
  headers: Readonly<Record<string, string>>,
): RequestCredentials {
  return headers.authorization === undefined ? "include" : "omit";
}

let interned: MattrApiConfig | null = null;

/** The same object while the connection is unchanged, so effects can depend on it. */
function internConfig(baseUrl: string, bearer: string | null): MattrApiConfig {
  const authorization = bearer === null ? undefined : `Bearer ${bearer}`;
  if (interned?.baseUrl === baseUrl && interned.headers.authorization === authorization) {
    return interned;
  }
  interned = { baseUrl, headers: authorization === undefined ? {} : { authorization } };
  return interned;
}

export class MattrApiError extends Schema.TaggedError<MattrApiError>()("MattrApiError", {
  status: Schema.Number,
  code: Schema.String,
  detail: Schema.UndefinedOr(Schema.String),
  message: Schema.String,
}) {}

export async function mattrApiRequest<A>(
  config: MattrApiConfig,
  path: string,
  init: {
    readonly method?: "GET" | "POST" | "DELETE";
    readonly body?: unknown;
    readonly signal?: AbortSignal;
  } = {},
): Promise<A> {
  const response = await fetch(`${config.baseUrl}${path}`, {
    method: init.method ?? "GET",
    headers: {
      ...config.headers,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    credentials: mattrFetchCredentials(config.headers),
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    ...(init.signal ? { signal: init.signal } : {}),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      readonly error?: unknown;
      readonly detail?: unknown;
    } | null;
    const code = typeof body?.error === "string" ? body.error : `http_${response.status}`;
    const detail = typeof body?.detail === "string" ? body.detail : undefined;
    throw new MattrApiError({
      status: response.status,
      code,
      detail,
      message: detail ? `${code}: ${detail}` : code,
    });
  }
  return (await response.json()) as A;
}
