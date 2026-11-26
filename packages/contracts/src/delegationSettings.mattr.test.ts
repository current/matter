import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  ClientServerSettingsPatch,
  DEFAULT_SERVER_SETTINGS,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeClientPatch = Schema.decodeUnknownSync(ClientServerSettingsPatch);

describe("mattr delegation settings", () => {
  it("turns delegation on with an empty exclusion list for settings files written before it", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.mattrMultiProviderDelegation).toBe(true);
    expect(decoded.mattrDelegationExcludedInstanceIds).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.mattrMultiProviderDelegation).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.mattrDelegationExcludedInstanceIds).toEqual([]);
  });

  it("keeps a saved choice", () => {
    const decoded = decodeServerSettings({
      mattrMultiProviderDelegation: false,
      mattrDelegationExcludedInstanceIds: ["claude-alt"],
    });
    expect(decoded.mattrMultiProviderDelegation).toBe(false);
    expect(decoded.mattrDelegationExcludedInstanceIds).toEqual(["claude-alt"]);
  });

  it("accepts both fields in server and client patches", () => {
    const patch = {
      mattrMultiProviderDelegation: false,
      mattrDelegationExcludedInstanceIds: ["codex"],
    };
    expect(decodePatch(patch)).toEqual(patch);
    expect(decodeClientPatch(patch)).toEqual(patch);
    expect(() => decodePatch({ mattrDelegationExcludedInstanceIds: ["not an id!"] })).toThrow();
  });
});
