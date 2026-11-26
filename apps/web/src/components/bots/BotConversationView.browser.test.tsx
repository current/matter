import { render } from "../../../test/render";
import {
  MATTER_ADDON_MANIFESTS,
  NO_BOT_PROVIDER_CAPABILITIES,
  type BotEvent,
  type BotIdentity,
  type BotMessage,
  type BotProviderDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { resetAddonStoreForTests } from "../../addons/addonStore";
import { SidebarProvider } from "../ui/sidebar";
import { resetBotsStoreForTests } from "./botsStore";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("../../addons/matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => config,
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
    attribution: "user-via-matter",
    authorBotId: null,
    markdown: "Status check on nightly?",
    parts: [{ type: "markdown", text: "Status check on nightly?" }],
    replyToId: null,
    attachments: [{ id: "a-1", name: "brief.pdf", mimeType: null, sizeBytes: 2048, url: null }],
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

type SendPayload = { readonly text: string; readonly clientNonce: string };

function useBotConversationServer(options: {
  readonly botOverride?: BotIdentity;
  readonly initialMessages?: ReadonlyArray<BotMessage>;
  readonly conversations?: ReadonlyArray<{ conversationId: string; title: string | null }>;
  readonly onSend?: (payload: SendPayload) => Promise<Response> | Response;
}) {
  resetBotsStoreForTests();
  resetAddonStoreForTests();
  const activeBot = options.botOverride ?? bot;
  const activeProvider: BotProviderDescriptor = options.conversations
    ? { ...provider, capabilities: { ...provider.capabilities, conversationDiscovery: true } }
    : provider;
  const activeMessages = options.initialMessages ?? messages;
  const sends: Array<SendPayload> = [];
  let stream: ReadableStreamDefaultController<Uint8Array> | null = null;
  const sentCopy = (payload: SendPayload) =>
    json({
      message: {
        ...messages[0],
        remoteId: `sent:${payload.clientNonce}`,
        role: "user",
        attachments: [],
        createdAt: "2026-11-25T13:00:00.000Z",
        markdown: payload.text,
        parts: [{ type: "markdown", text: payload.text }],
        seq: null,
        clientNonce: payload.clientNonce,
        deliveryState: "sent",
      },
    });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/api/mattr/")) return realFetch(input, init);
    switch (url.pathname) {
      case "/api/mattr/bots/providers":
        return json({ providers: [activeProvider] });
      case "/api/mattr/bots/conversations":
        return json({
          conversations: (options.conversations ?? []).map((conversation) => ({
            ...conversation,
            providerId: "grok-bot",
            accountScopeId: "local",
            botId: activeBot.remoteBotId,
            participantBotIds: [],
            kind: "direct",
            parentConversationId: null,
            unreadCount: 0,
            lastActivityAt: null,
            activityState: "idle",
            officialAppUrl: null,
          })),
        });
      case "/api/mattr/bots/bots":
        return json({ bots: [activeBot] });
      case "/api/mattr/bots/pending":
        return json({ requests: [] });
      case "/api/mattr/bots/messages":
        if (init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as SendPayload;
          sends.push(payload);
          return options.onSend ? options.onSend(payload) : sentCopy(payload);
        }
        return json({ messages: activeMessages, olderCursor: null });
      case "/api/mattr/bots/cancel":
        return json({ cancelled: true });
      case "/api/mattr/addons/reconnect":
        return json({
          addons: MATTER_ADDON_MANIFESTS.map((manifest) => ({
            manifest,
            state: {
              id: manifest.id,
              enabled: manifest.id === "grok-bot",
              enablementSource: "user",
              updatedAt: null,
              status: manifest.id === "grok-bot" ? { kind: "connected" } : { kind: "disabled" },
            },
          })),
        });
      case "/api/mattr/bots/events":
        return new Response(
          new ReadableStream<Uint8Array>({
            start: (controller) => {
              stream = controller;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      default:
        return new Response("not found", { status: 404 });
    }
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    sends,
    sentCopy,
    /** Waits for the client's event stream, then delivers one server event over it. */
    push: async (event: BotEvent) => {
      await vi.waitFor(() => expect(stream).not.toBeNull());
      stream?.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    },
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      resetBotsStoreForTests();
      resetAddonStoreForTests();
    },
  };
}

const renderView = () =>
  render(
    <SidebarProvider>
      <BotConversationView providerId="grok-bot" botId="bot-black" />
    </SidebarProvider>,
  );

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
    const chip = page.getByLabelText("File attachment, brief.pdf, 2.00 KB");
    await expect.element(chip).toBeVisible();
    expect(chip.element().tagName).not.toBe("A");
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

  it("swaps send for stop and shows Grok's live activity line while the bot is working", async () => {
    using _server = useBotConversationServer({
      botOverride: {
        ...bot,
        status: "working",
        metadata: {
          grokActivity: "searching",
          activityDetail: "is searching X for composers",
          description: "Monitors builds and alerts.",
        },
      },
      initialMessages: [],
    });
    await using screen = await renderView();

    await expect.element(page.getByRole("button", { name: "Stop generation" })).toBeVisible();
    await expect
      .element(page.getByRole("status").filter({ hasText: "Searching X for composers" }))
      .toBeVisible();
    expect(screen.container.querySelector('[data-bot-header-status="working"]')).not.toBeNull();
  });

  it("shows a send at once, keeps the composer focused, and never duplicates it", async () => {
    let release: (response: Response) => void = () => undefined;
    using server = useBotConversationServer({
      onSend: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await using screen = await renderView();

    const input = page.getByRole("textbox", { name: "Message Nightwatch" });
    await userEvent.type(input, "Line one");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}line two");
    await expect.element(input).toHaveValue("Line one\nline two");
    await userEvent.keyboard("{Enter}");

    await expect.element(input).toHaveValue("");
    await expect.element(input).toHaveFocus();
    const pending = screen.container.querySelector('[data-delivery-state="pending"]');
    expect(pending?.textContent).toContain("line two");
    expect(server.sends.map((send) => send.text)).toEqual(["Line one\nline two"]);

    const { clientNonce } = server.sends[0]!;
    release(server.sentCopy(server.sends[0]!));
    await server.push({
      type: "message-upserted",
      message: {
        ...messages[0]!,
        remoteId: "grok-9",
        markdown: "Line one\nline two",
        seq: 3,
        clientNonce,
      },
    });
    await expect
      .poll(() => screen.container.querySelector('[data-delivery-state="pending"]'))
      .toBeNull();
    expect(screen.container.querySelectorAll("[data-user-message-bubble]")).toHaveLength(2);
  });

  it("keeps a failed send with the provider's reason and retries it", async () => {
    let attempts = 0;
    using server = useBotConversationServer({
      onSend: (payload) => {
        attempts += 1;
        return attempts === 1
          ? new Response(
              JSON.stringify({ error: "provider_error", detail: "Grok Bot is out of usage" }),
              { status: 502, headers: { "content-type": "application/json" } },
            )
          : server.sentCopy(payload);
      },
    });
    await using screen = await renderView();

    await userEvent.type(
      page.getByRole("textbox", { name: "Message Nightwatch" }),
      "Deploy?{Enter}",
    );
    await expect.element(page.getByText("Not sent: Grok Bot is out of usage")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Retry" }));

    await expect
      .element(page.getByText("Not sent: Grok Bot is out of usage"))
      .not.toBeInTheDocument();
    expect(server.sends.map((send) => send.clientNonce)).toEqual([
      server.sends[0]!.clientNonce,
      server.sends[0]!.clientNonce,
    ]);
    await expect
      .poll(() => [...screen.container.querySelectorAll("[data-delivery-state]")].at(-1))
      .toHaveAttribute("data-delivery-state", "sent");
    expect(
      [...screen.container.querySelectorAll("[data-delivery-state]")].at(-1)?.textContent,
    ).toContain("Deploy?");
  });

  it("disables the composer while Grok Bot is disconnected and reconnects in one click", async () => {
    using server = useBotConversationServer({});
    await using _screen = await renderView();

    await expect.element(page.getByText("All pipelines are green.")).toBeVisible();
    await server.push({
      type: "provider-status",
      providerId: "grok-bot",
      status: { kind: "disconnected", detail: "Grok Bot isn't reachable on debug port 9222." },
    });

    const input = page.getByRole("textbox", { name: "Message Nightwatch" });
    await expect
      .element(page.getByRole("alert").getByText("Grok Bot isn't connected"))
      .toBeVisible();
    await expect.element(input).toBeDisabled();
    await userEvent.click(page.getByRole("alert").getByRole("button", { name: "Reconnect" }));

    await expect.element(input).toBeEnabled();
    await expect.element(page.getByText("Grok Bot isn't connected")).not.toBeInTheDocument();
    expect(server.fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toContain(
      "/api/mattr/addons/reconnect",
    );
  });

  it("follows new replies at the bottom but keeps the reader's place when scrolled up", async () => {
    const long = Array.from({ length: 40 }, (_, index): BotMessage => ({
      ...messages[1]!,
      remoteId: `long-${index}`,
      markdown: `Report line ${index}`,
      seq: index + 1,
    }));
    using server = useBotConversationServer({ initialMessages: long });
    await using screen = await renderView();

    await expect.element(page.getByText("Report line 39")).toBeVisible();
    const scroller = screen.container.querySelector<HTMLElement>("[data-bot-transcript-scroll]")!;
    const reply = (index: number): BotEvent => ({
      type: "message-upserted",
      message: {
        ...messages[1]!,
        remoteId: `new-${index}`,
        markdown: `Fresh ${index}`,
        seq: 100 + index,
      },
    });

    await server.push(reply(1));
    await expect.element(page.getByText("Fresh 1")).toBeVisible();

    scroller.scrollTop = -400;
    const anchor = page.getByText("Report line 20").element();
    const before = anchor.getBoundingClientRect().top;
    await server.push(reply(2));
    await expect.element(page.getByText("Fresh 2")).toBeInTheDocument();
    expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
  });

  it("renders a single breadcrumb when the Bot shares its provider's name", async () => {
    using _server = useBotConversationServer({ botOverride: { ...bot, name: "Grok Bot" } });
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("All pipelines are green.")).toBeVisible();
    const crumbs = screen.container.querySelector('nav[aria-label="Bot breadcrumb"]');
    expect(crumbs?.textContent?.match(/Grok Bot/g)?.length).toBe(1);
  });

  it("puts the transcript and composer in the same column width", async () => {
    using _server = useBotConversationServer({});
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("All pipelines are green.")).toBeVisible();
    const column = screen.container.querySelector<HTMLElement>("[data-bot-transcript-column]");
    const composer = screen.container.querySelector<HTMLElement>("[data-bot-composer-form]");
    const columnBox = column!.getBoundingClientRect();
    const composerBox = composer!.getBoundingClientRect();
    expect(Math.abs(columnBox.left - composerBox.left)).toBeLessThanOrEqual(1);
    expect(Math.abs(columnBox.width - composerBox.width)).toBeLessThanOrEqual(1);
  });

  it("folds scheduled trigger prompts into an expandable event row", async () => {
    const trigger: BotMessage = {
      ...messages[0]!,
      remoteId: "m-trigger",
      markdown: "Promise check: TASK-1 — promise is past its deadline and still open.",
      parts: [],
      seq: 3,
    };
    using _server = useBotConversationServer({ initialMessages: [...messages, trigger] });
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    const row = page.getByRole("button", { name: "Scheduled check · TASK-1" });
    await expect.element(row).toBeVisible();
    expect(screen.container.querySelectorAll("[data-user-message-bubble]")).toHaveLength(1);
    await row.click();
    await expect.element(page.getByText(/past its deadline and still open/)).toBeVisible();
  });

  it("shows a message another Bot wrote as that Bot, not as the user", async () => {
    const fromOtherBot: BotMessage = {
      ...messages[0]!,
      remoteId: "m-other",
      attribution: "other-agent",
      authorBotId: "bot-trading",
      markdown: "**Trading:** Welcome aboard.",
      parts: [],
      attachments: [],
      seq: 3,
    };
    using _server = useBotConversationServer({ initialMessages: [...messages, fromOtherBot] });
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    await expect.element(page.getByText("Welcome aboard.")).toBeVisible();
    const row = screen.container.querySelector("[data-bot-other-author]");
    expect(row?.textContent).toContain("Trading");
    expect(row?.textContent).not.toContain("**Trading:**");
    expect(screen.container.querySelectorAll("[data-user-message-bubble]")).toHaveLength(1);
  });

  it("labels untitled conversation tabs on an opaque strip", async () => {
    using _server = useBotConversationServer({
      conversations: [
        { conversationId: "bot-black", title: null },
        { conversationId: "c-2", title: "Build Notion team hub" },
      ],
    });
    await using screen = await render(
      <SidebarProvider>
        <BotConversationView providerId="grok-bot" botId="bot-black" />
      </SidebarProvider>,
    );

    await expect.element(page.getByRole("tab", { name: "Main chat" })).toBeVisible();
    await expect.element(page.getByRole("tab", { name: "Build Notion team hub" })).toBeVisible();
    const strip = screen.container.querySelector<HTMLElement>("[data-bot-conversation-tabs]");
    expect(getComputedStyle(strip!).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  });
});
