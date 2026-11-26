import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { capVoiceLaunchModel } from "./voiceLaunchModel.ts";

const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  models: [
    { slug: "claude-fable-5-2", name: "Claude Fable 5.2" },
    { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
  ],
} as unknown as ServerProvider;

describe("capVoiceLaunchModel", () => {
  it("steps a Fable default down to Opus on the same account, keeping its options", () => {
    expect(
      capVoiceLaunchModel(
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5-2",
          options: [{ id: "effort", value: "high" }],
        },
        [claude],
      ),
    ).toEqual({
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
  });

  it("leaves Opus and other providers' models alone", () => {
    const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
    const neon = { instanceId: ProviderInstanceId.make("antigravity"), model: "gemini-4-neon" };
    expect(capVoiceLaunchModel(opus, [claude])).toBe(opus);
    expect(capVoiceLaunchModel(neon, [claude])).toBe(neon);
  });
});
