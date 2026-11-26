import type {
  AuthEnvironmentScope,
  EnvironmentAuthInvalidError,
  EnvironmentInternalError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import { HttpServerRequest, HttpServerRespondable, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import {
  failEnvironmentAuthInvalid,
  failEnvironmentInternal,
  failEnvironmentScopeRequired,
} from "../auth/http.ts";

/** Shared plumbing for Matter's fork-only `/api/mattr/*` routes. */

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
} as const;

export const authenticate = Effect.fnUntraced(function* (scope: AuthEnvironmentScope) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* serverAuth.authenticateHttpRequest(request).pipe(
    Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
      failEnvironmentAuthInvalid(
        EnvironmentAuth.serverAuthCredentialReason(error),
        EnvironmentAuth.serverAuthDpopFailureReason(error),
      ),
    ),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      failEnvironmentInternal("internal_error", error),
    ),
  );
  if (!session.scopes.includes(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
});

export const catchAuthErrors = <A, R>(
  effect: Effect.Effect<
    A,
    EnvironmentAuthInvalidError | EnvironmentInternalError | EnvironmentScopeRequiredError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
      EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
    }),
  );

export const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE_HEADERS });

/** The request body decoded, or null when it is missing or invalid. */
export const readJson = Effect.fnUntraced(function* <A>(
  decode: (raw: unknown) => Effect.Effect<A, Schema.SchemaError>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const raw = yield* request.json.pipe(Effect.option);
  if (raw._tag === "None") return null;
  const decoded = yield* decode(raw.value).pipe(Effect.option);
  return decoded._tag === "None" ? null : decoded.value;
});

export const readQuery = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const index = request.url.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : request.url.slice(index + 1));
});

export const INVALID_REQUEST = json({ error: "invalid_request" }, 400);
