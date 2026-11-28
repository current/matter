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

describe("Matter delegation settings", () => {
  it("turns delegation on with an empty exclusion list for settings files written before it", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.mattrMultiProviderDelegation).toBe(true);
    expect(decoded.mattrDelegationExcludedInstanceIds).toEqual([]);
    expect(decoded.mattrDelegationBalanceByPace).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.mattrMultiProviderDelegation).toBe(true);
    expect(DEFAULT_SERVER_SETTINGS.mattrDelegationExcludedInstanceIds).toEqual([]);
    expect(DEFAULT_SERVER_SETTINGS.mattrDelegationBalanceByPace).toBe(true);
  });

  it("keeps a saved choice", () => {
    const decoded = decodeServerSettings({
      mattrMultiProviderDelegation: false,
      mattrDelegationExcludedInstanceIds: ["claude-alt"],
      mattrDelegationBalanceByPace: false,
    });
    expect(decoded.mattrMultiProviderDelegation).toBe(false);
    expect(decoded.mattrDelegationExcludedInstanceIds).toEqual(["claude-alt"]);
    expect(decoded.mattrDelegationBalanceByPace).toBe(false);
  });

  it("accepts every field in server and client patches", () => {
    const patch = {
      mattrMultiProviderDelegation: false,
      mattrDelegationExcludedInstanceIds: ["codex"],
      mattrDelegationBalanceByPace: false,
    };
    expect(decodePatch(patch)).toEqual(patch);
    expect(decodeClientPatch(patch)).toEqual(patch);
    expect(() => decodePatch({ mattrDelegationExcludedInstanceIds: ["not an id!"] })).toThrow();
  });
});
