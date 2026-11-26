import { describe, expect, it } from "vite-plus/test";

import { buildVoiceApiConfig } from "./voiceApiConfig";

describe("buildVoiceApiConfig", () => {
  it("omits credentials when a bearer header authenticates, so the wildcard CORS preflight passes", () => {
    expect(
      buildVoiceApiConfig(
        {
          httpBaseUrl: "http://127.0.0.1:3773/",
          httpAuthorization: { _tag: "Bearer", token: "desktop-token" },
        },
        "t3code://app",
      ),
    ).toEqual({
      baseUrl: "http://127.0.0.1:3773",
      headers: { authorization: "Bearer desktop-token" },
      credentials: "omit",
    });
  });

  it("sends cookies when the connection is cookie-authenticated on the page's own origin", () => {
    expect(
      buildVoiceApiConfig(
        { httpBaseUrl: "", httpAuthorization: null },
        "https://mac.tailnet.ts.net",
      ),
    ).toEqual({
      baseUrl: "https://mac.tailnet.ts.net",
      headers: {},
      credentials: "include",
    });
  });
});
