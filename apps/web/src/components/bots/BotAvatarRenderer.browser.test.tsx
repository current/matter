import { render } from "../../../test/render";
import type { BotIdentity } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { BotAvatar } from "./BotAvatarRenderer";

const grokBot: BotIdentity = {
  providerId: "grok-bot",
  remoteBotId: "bot-alpha",
  accountScopeId: "local",
  name: "Alpha",
  avatar: { kind: "parametric", shape: "squircle", color: "cobalt", seed: "bot-alpha" },
  status: "working",
  unreadCount: 0,
  defaultConversationId: "bot-alpha",
  officialAppUrl: "grokbot://app/v1/prompt?id=bot-alpha",
  metadata: { grokActivity: "thinking" },
};

describe("BotAvatar", () => {
  it("draws Grok Bot Bots as their character with Grok Bot's own activity", async () => {
    await using _screen = await render(<BotAvatar bot={grokBot} size={24} activity="working" />);
    const character = page.getByRole("img", { name: "Alpha (thinking)" });
    await expect.element(character).toBeVisible();
    await expect.element(character).toHaveAttribute("data-slot", "grok-bot-character");
    await expect.element(character).toHaveAttribute("data-shape", "squircle");
    await expect.element(character).toHaveAttribute("data-palette", "cobalt");
  });

  it("falls back to the shared state when the activity shown is not the Bot's own", async () => {
    await using _screen = await render(
      <BotAvatar bot={grokBot} size={16} activity="waiting_for_user" />,
    );
    await expect
      .element(page.getByRole("img", { name: "Alpha (needs attention)" }))
      .toHaveAttribute("data-activity-state", "attention");
  });

  it("keeps other providers on the neutral avatar", async () => {
    await using screen = await render(
      <BotAvatar bot={{ ...grokBot, providerId: "other-bot" }} size={24} activity="working" />,
    );
    await expect.element(page.getByText("A")).toBeVisible();
    expect(screen.container.querySelector('[data-slot="grok-bot-character"]')).toBeNull();
  });
});
