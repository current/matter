import * as Effect from "effect/Effect";

import * as RemoteEnvironmentAuthorization from "./authorization/service.ts";
import type { PreparedConnection } from "./connection/model.ts";
import * as ManagedRelay from "./relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  type EnvironmentHttpAuthHeaders,
} from "./state/environmentHttpAuth.ts";

/**
 * Matter fork: authenticated requests to `/api/mattr/*` routes, which sit outside the contract's
 * HTTP API groups. Reuses the contract request path so Bearer, cookie and DPoP (proof signing,
 * token renewal, one retry on a rejected token) behave exactly like every other environment call.
 * `send` performs the fetch with the headers and URL this module settles on for each attempt.
 */
export const executeMatterEnvironmentRequest = Effect.fn(
  "clientRuntime.matter.executeEnvironmentRequest",
)(function* <A, E>(input: {
  readonly prepared: PreparedConnection;
  readonly method: "GET" | "POST";
  /** Absolute server path such as `/api/mattr/voice-assistant/turn`. */
  readonly path: string;
  readonly timeoutMs: number;
  readonly send: (request: {
    readonly url: string;
    readonly headers: EnvironmentHttpAuthHeaders;
  }) => Effect.Effect<A, E>;
  /** True for a rejected credential, so a DPoP request renews its token once. */
  readonly isUnauthorizedResponse?: (response: NoInfer<A>) => boolean;
}) {
  let requestUrl = input.prepared.httpBaseUrl;
  return yield* executeAuthenticatedEnvironmentHttpRequest<"voice", A, E, never>({
    group: "voice",
    prepared: input.prepared,
    signer: yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner),
    remoteAuthorization: yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    ),
    method: input.method,
    // The contract builder resolves the current origin (a relay renews it); the path is ours.
    url: (urls) => {
      requestUrl = new URL(input.path, new URL(urls.status()).origin).toString();
      return requestUrl;
    },
    timeoutMs: input.timeoutMs,
    // Audio and credentials never follow a redirect to another host.
    requestInit: { redirect: "error" },
    request: ({ headers }) => input.send({ url: requestUrl, headers }),
    ...(input.isUnauthorizedResponse === undefined
      ? {}
      : { isUnauthorizedResponse: input.isUnauthorizedResponse }),
  });
});
