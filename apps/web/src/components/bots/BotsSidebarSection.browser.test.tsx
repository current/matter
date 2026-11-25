import { render } from "../../../test/render";
import {
  MATTR_ADDON_MANIFESTS,
  NO_BOT_PROVIDER_CAPABILITIES,
  type AddonEntry,
  type BotIdentity,
  type BotProviderDescriptor,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "../../index.css";
import { resetAddonStoreForTests } from "../../addons/addonStore";
import { SidebarProvider } from "../ui/sidebar";
import { resetBotsStoreForTests } from "./botsStore";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("../../addons/mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => config,
}));

import { BotsSidebarSection } from "./BotsSidebarSection";

const addons = (grokEnabled: boolean): ReadonlyArray<AddonEntry> =>
  MATTR_ADDON_MANIFESTS.map((manifest) => {
    const enabled = manifest.id === "grok-bot" && grokEnabled;
    return {
      manifest,
      state: {
        id: manifest.id,
        enabled,
        enablementSource: enabled ? "user" : "default",
        updatedAt: null,
        status: enabled ? { kind: "connected" } : { kind: "disabled" },
      },
    };
  });

const provider: BotProviderDescriptor = {
  providerId: "grok-bot",
  addonId: "grok-bot",
  displayName: "Grok Bot",
  transport: "local-app-bridge",
  experimental: true,
  status: { kind: "connected" },
  capabilities: NO_BOT_PROVIDER_CAPABILITIES,
  officialAppUrl: null,
};

const bot: BotIdentity = {
  providerId: "grok-bot",
  remoteBotId: "bot-1",
  accountScopeId: "acct",
  name: "Ada",
  avatar: null,
  status: "working",
  unreadCount: 2,
  defaultConversationId: null,
  officialAppUrl: null,
  metadata: {},
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;

function serve(grokEnabled: boolean) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/api/mattr/")) return realFetch(input, init);
    switch (url.pathname) {
      case "/api/mattr/addons":
        return json({ addons: addons(grokEnabled) });
      case "/api/mattr/bots/providers":
        return json({ providers: [provider] });
      case "/api/mattr/bots/bots":
        return json({ bots: [bot] });
      case "/api/mattr/bots/pending":
        return json({ requests: [] });
      case "/api/mattr/bots/events":
        return new Response(new ReadableStream(), {
          headers: { "content-type": "text/event-stream" },
        });
      default:
        return new Response("not found", { status: 404 });
    }
  });
}

const botsCalls = (fetchMock: ReturnType<typeof serve>) =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/mattr/bots/"));

function useBotsServer(grokEnabled: boolean) {
  window.localStorage.removeItem("mattr:addons:v1");
  resetAddonStoreForTests();
  resetBotsStoreForTests();
  const fetchMock = serve(grokEnabled);
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    [Symbol.dispose]: () => {
      vi.unstubAllGlobals();
      window.localStorage.removeItem("mattr:addons:v1");
      resetAddonStoreForTests();
      resetBotsStoreForTests();
    },
  };
}

describe("BotsSidebarSection", () => {
  it("renders nothing and never contacts the Bots API while no Bots add-on is enabled", async () => {
    using server = useBotsServer(false);
    const { fetchMock } = server;
    await using screen = await render(
      <SidebarProvider>
        <BotsSidebarSection />
      </SidebarProvider>,
    );
    const mattrCalls = () =>
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/mattr/"));
    await expect.poll(() => mattrCalls().length).toBe(1);
    expect(screen.container.querySelector("[data-bots-sidebar-section]")).toBeNull();
    expect(botsCalls(fetchMock)).toEqual([]);
  });

  it("lists Bots with their activity and unread count once the add-on is on", async () => {
    using _server = useBotsServer(true);
    await using _screen = await render(
      <SidebarProvider>
        <BotsSidebarSection />
      </SidebarProvider>,
    );
    await expect.element(page.getByRole("heading", { name: "Bots" })).toBeVisible();
    const row = page.getByRole("link", { name: /Ada/ });
    await expect.element(row).toHaveAttribute("href", "/bots/grok-bot/bot-1");
    await expect.element(page.getByRole("img", { name: "Working" })).toBeVisible();
    await expect.element(page.getByLabelText("2 unread messages")).toBeVisible();
  });
});
