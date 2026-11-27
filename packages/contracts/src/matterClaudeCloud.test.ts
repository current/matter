import { describe, expect, it } from "@effect/vitest";

import { ADDON_SECRET_CONFIG_KEY_PATTERN, findAddonManifest } from "./matterAddons.ts";
import {
  CLAUDE_CLOUD_DEFAULT_SETTINGS,
  claudeCloudAgentInstructions,
  claudeCloudSettingsFromConfig,
  parseClaudeCloudSessionRef,
} from "./matterClaudeCloud.ts";

describe("claude-cloud add-on", () => {
  it("is registered off by default and experimental", () => {
    const manifest = findAddonManifest("claude-cloud");
    expect(manifest?.defaultEnabled).toBe(false);
    expect(manifest?.experimental).toBe(true);
    expect(manifest?.settingsRoute).toBe("/settings/addons#addon-claude-cloud");
  });

  it("keeps every settings key clear of the secret-key pattern", () => {
    for (const key of Object.keys(CLAUDE_CLOUD_DEFAULT_SETTINGS)) {
      expect(ADDON_SECRET_CONFIG_KEY_PATTERN.test(key), key).toBe(false);
    }
  });

  it("reads stored config with defaults for missing or invalid values", () => {
    expect(claudeCloudSettingsFromConfig({})).toEqual(CLAUDE_CLOUD_DEFAULT_SETTINGS);
    expect(CLAUDE_CLOUD_DEFAULT_SETTINGS.agentDelegationMode).toBe("auto");
    expect(CLAUDE_CLOUD_DEFAULT_SETTINGS.offloadPolicy).toBe("balanced");
    expect(
      claudeCloudSettingsFromConfig({
        defaultInstanceId: "claude-alt",
        agentDelegationMode: "ask",
        delegationRules: "Only e2e suites.",
        autoPushBeforeLaunch: true,
      }),
    ).toEqual({
      defaultInstanceId: "claude-alt",
      offloadPolicy: "ask",
      agentDelegationMode: "ask",
      delegationRules: "Only e2e suites.",
      autoPushBeforeLaunch: true,
    });
    expect(
      claudeCloudSettingsFromConfig({
        defaultInstanceId: "not valid!",
        agentDelegationMode: "sometimes",
        delegationRules: 42,
        autoPushBeforeLaunch: "yes",
      }),
    ).toEqual(CLAUDE_CLOUD_DEFAULT_SETTINGS);
  });

  it("keeps config written before offload policies, and derives the mode from the policy", () => {
    expect(claudeCloudSettingsFromConfig({ agentDelegationMode: "auto" }).offloadPolicy).toBe(
      "balanced",
    );
    expect(claudeCloudSettingsFromConfig({ agentDelegationMode: "off" }).offloadPolicy).toBe("off");
    expect(
      claudeCloudSettingsFromConfig({ offloadPolicy: "battery_saver", agentDelegationMode: "off" }),
    ).toMatchObject({ offloadPolicy: "battery_saver", agentDelegationMode: "auto" });
    expect(claudeCloudSettingsFromConfig({ offloadPolicy: "sometimes" }).offloadPolicy).toBe(
      "balanced",
    );
  });

  it("parses session ids and claude.ai links, and nothing else", () => {
    expect(parseClaudeCloudSessionRef(" cse_01ABCDEFGH ")).toBe("cse_01ABCDEFGH");
    expect(parseClaudeCloudSessionRef("session_01XYZ98765")).toBe("session_01XYZ98765");
    expect(parseClaudeCloudSessionRef("https://claude.ai/code/cse_01ABCDEFGH?tab=diff")).toBe(
      "cse_01ABCDEFGH",
    );
    expect(parseClaudeCloudSessionRef("https://evil.example/code/cse_01ABCDEFGH")).toBeNull();
    expect(parseClaudeCloudSessionRef("cse_01ABC; rm -rf /")).toBeNull();
  });

  it("writes the agent note only when delegation is on, with the user's rules", () => {
    expect(
      claudeCloudAgentInstructions({
        ...CLAUDE_CLOUD_DEFAULT_SETTINGS,
        offloadPolicy: "off",
        agentDelegationMode: "off",
      }),
    ).toBe("");
    const auto = claudeCloudAgentInstructions(CLAUDE_CLOUD_DEFAULT_SETTINGS);
    expect(auto).toContain("claude_cloud_launch");
    expect(auto).toContain("`claude_cloud_status`");
    expect(auto).toContain("advice.level");
    expect(auto).not.toContain("delegation rules");
    const ask = claudeCloudAgentInstructions({
      ...CLAUDE_CLOUD_DEFAULT_SETTINGS,
      offloadPolicy: "ask",
      agentDelegationMode: "ask",
      delegationRules: "Only suites\nover five minutes.",
    });
    expect(ask).toContain("userApproved: true");
    expect(ask).toContain("The user's delegation rules: Only suites over five minutes.");
    expect(ask.split("\n")).toHaveLength(5);
  });
});
