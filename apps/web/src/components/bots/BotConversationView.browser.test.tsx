import { render } from "../../../test/render";
import {
  NO_BOT_PROVIDER_CAPABILITIES,
  type BotIdentity,
  type BotMessage,
  type BotProviderDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { SidebarProvider } from "../ui/sidebar";
import { resetBotsStoreForTests } from "./botsStore";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("../../addons/mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => config,
}));

import { BotConversationView } from "./BotConversationView";

const provider: BotProviderDescriptor = {
  providerId: "grok-bot",
  addonId: "grok-bot",
  displayName: "Grok Bot",
  transport: "local-app-bridge",
  experimental: true,
  status: { kind: "connected" },
  capabilities: {
    ...NO_BOT_PROVIDER_CAPABILITIES,
    agentDiscovery: true,
    avatarMetadata: true,
    history: "paged",
    sendMessage: true,
    cancel: true,
    officialAppDeepLink: true,
  },
  officialAppUrl: "grokbot://app/v1/prompt",
};

const bot: BotIdentity = {
  providerId: "grok-bot",
  remoteBotId: "bot-black",
  accountScopeId: "local",
  name: "Nightwatch",
  avatar: { kind: "parametric", shape: "squircle", color: "black", seed: "bot-black" },
  status: "idle",
  unreadCount: 0,
  defaultConversationId: "bot-black",
  officialAppUrl: "grokbot://app/v1/prompt?id=bot-black",
  metadata: { grokActivity: "idle", description: "Monitors builds and alerts." },
};

const messages: ReadonlyArray<BotMessage> = [
  {
    remoteId: "m-1",
    conversationId: "bot-black",
    providerId: "grok-bot",
    role: "user",
    attribution: "user-via-mattr",
    authorBotId: null,
    markdown: "Status check on nightly?",
    parts: [{ type: "markdown", text: "Status check on nightly?" }],
    replyToId: null,
    attachments: [],
    artifacts: [],
    createdAt: "2026-11-25T12:00:00.000Z",
    seq: 1,
    clientNonce: null,
    deliveryState: "sent",
  },
  {
    remoteId: "m-2",
    conversationId: "bot-black",
    providerId: "grok-bot",
    role: "agent",
    attribution: "agent",
    authorBotId: "bot-black",
    markdown: "All pipelines are green.",
    parts: [{ type: "markdown", text: "All pipelines are green." }],
    replyToId: null,
    attachments: [],
    artifacts: [],
    createdAt: "2026-11-25T12:00:05.000Z",
    seq: 2,
    clientNonce: null,
    deliveryState: "sent",
  },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;

function useBotConversationServer(options: {
  readonly botOverride?: BotIdentity;
  readonly initialMessages?: ReadonlyArray<BotMessage>;
}) {
  resetBotsStoreForTests();
  const activeBot = options.botOverride ?? bot;
  const activeMessages = options.initialMessages ?? messages;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/api/mattr/")) return realFetch(input, init);
    switch (url.pathname) {
      case "/api/mattr/bots/providers":
        return json({ providers: [provider] });
      case "/api/mattr/bots/bots":
        return json({ bots: [activeBot] });
      case "/api/mattr/bots/pending":
        return json({ requests: [] });
      case "/api/mattr/bots/messages":
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as {
            text: string;
            clientNonce: string;
          };
          return json({
            message: {
              ...activeMessages[0],
              remoteId: "m-sent",
              role: "user",
              markdown: payload.text,
              parts: [{ type: "markdown", text: payload.text }],
              seq: 3,
              clientNonce: payload.clientNonce,
              deliveryState: "sent",
            },
          });
        }
        return json({ messages: activeMessages, olderCursor: null });
      case "/api/mattr/bots/cancel":
        return json({ cancelled: true });
      case "/api/mattr/bots/events":
        return new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      default:
        return new Response("not found", { status: 404 });
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      resetBotsStoreForTests();
    },
  };
}

describe("BotConversationView", () => {
  it("renders native ComposerSurface, user bubble, bot prose, and obsidian character avatar", async () => {
    using _server = useBotConversationServer({});
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Status check on nightly?")).toBeVisible();
    await expect.element(page.getByText("All pipelines are green.")).toBeVisible();
    await expect
      .element(page.getByRole("img", { name: "Nightwatch (idle)" }).first())
      .toHaveAttribute("data-palette", "black");

    expect(screen.container.querySelector('[data-slot="composer-shell"]')).not.toBeNull();
    expect(screen.container.querySelector('[data-slot="composer-host"]')).not.toBeNull();
    expect(
      screen.container.querySelector('[data-chat-composer-main-surface="true"]'),
    ).not.toBeNull();
    expect(screen.container.querySelector("[data-user-message-bubble]")).not.toBeNull();
    expect(screen.container.querySelector("[data-bot-composer-send]")).not.toBeNull();
  });

  it("renders centered hero empty state when an idle bot has no messages yet", async () => {
    using _server = useBotConversationServer({
      initialMessages: [],
    });
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Monitors builds and alerts.")).toBeVisible();
    expect(screen.container.querySelector("[data-bot-empty-state]")).not.toBeNull();
  });

  it("swaps send for stop and shows live working status while the bot is working", async () => {
    using _server = useBotConversationServer({
      botOverride: {
        ...bot,
        status: "working",
        metadata: { grokActivity: "thinking", description: "Monitors builds and alerts." },
      },
      initialMessages: [],
    });
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    await expect.element(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
    expect(screen.container.querySelector("[data-bot-working-indicator]")).not.toBeNull();
    expect(screen.container.querySelector('[data-bot-header-status="working"]')).not.toBeNull();
  });
});
