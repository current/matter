import { render } from "../../test/render";
import { MATTR_ADDON_MANIFESTS, type AddonEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../index.css";
import { resetAddonStoreForTests } from "./addonStore";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("./mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => config,
}));

import { AddonsSettingsPanel } from "./AddonsSettingsPanel";

function entries(enabled: Record<string, boolean>): ReadonlyArray<AddonEntry> {
  return MATTR_ADDON_MANIFESTS.map((manifest) => {
    const on = enabled[manifest.id] ?? false;
    return {
      manifest,
      state: {
        id: manifest.id,
        enabled: on,
        enablementSource: on ? "user" : "default",
        updatedAt: null,
        status: on
          ? manifest.id === "grok-bot"
            ? { kind: "app_unavailable", detail: "Open Grok Bot to connect." }
            : { kind: "connected" }
          : { kind: "disabled" },
      },
    };
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;

describe("AddonsSettingsPanel", () => {
  let enabled: Record<string, boolean>;
  let refuseWrites: boolean;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/api/mattr/addons")) return realFetch(input, init);
    if (url.pathname === "/api/mattr/addons/enabled") {
      if (refuseWrites) return json({ error: "forbidden" }, 403);
      const body = JSON.parse(String(init?.body)) as { id: string; enabled: boolean };
      enabled = { ...enabled, [body.id]: body.enabled };
    }
    return json({ addons: entries(enabled) });
  });

  const addonCalls = () =>
    fetchMock.mock.calls.filter(([input]) => String(input).includes("/api/mattr/addons")).length;

  function useAddonServer({ refuse = false } = {}): Disposable {
    enabled = {};
    refuseWrites = refuse;
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    window.localStorage.removeItem("mattr:addons:v1");
    resetAddonStoreForTests();
    return {
      [Symbol.dispose]: () => {
        vi.unstubAllGlobals();
        window.localStorage.removeItem("mattr:addons:v1");
        resetAddonStoreForTests();
      },
    };
  }

  it("lists every add-on, off by default, with its status", async () => {
    using _server = useAddonServer();
    await using screen = await render(<AddonsSettingsPanel />);
    await expect
      .element(page.getByText("Talk to your existing Grok Bot teammates", { exact: false }))
      .toBeVisible();
    await expect.element(page.getByText("A hands-free assistant", { exact: false })).toBeVisible();
    await expect.element(page.getByText("Experimental")).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).not.toBeChecked();
    await expect
      .element(page.getByRole("switch", { name: "Enable Voice Assistant" }))
      .not.toBeChecked();
    expect(screen.container.querySelectorAll("[data-addon-status]")).toHaveLength(
      MATTR_ADDON_MANIFESTS.length,
    );
  });

  it("turns an add-on on, shows its server status, and offers its settings", async () => {
    using _server = useAddonServer();
    await using _screen = await render(<AddonsSettingsPanel />);
    await expect.poll(() => addonCalls()).toBe(1);

    await userEvent.click(page.getByRole("switch", { name: "Enable Grok Bot" }));
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).toBeChecked();
    await expect.element(page.getByText("Open Grok Bot to connect.")).toBeVisible();
    const write = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/enabled"));
    expect(JSON.parse(String(write?.[1]?.body))).toEqual({
      id: "grok-bot",
      enabled: true,
      source: "user",
    });
    // Grok Bot is configured on this page, so it gets no separate Configure link.
    await expect.element(page.getByRole("link", { name: "Configure" })).not.toBeInTheDocument();

    await userEvent.click(page.getByRole("switch", { name: "Enable Voice Assistant" }));
    await expect
      .element(page.getByRole("link", { name: "Configure" }))
      .toHaveAttribute("href", "/settings/general#mattr-voice-assistant");

    await userEvent.click(page.getByRole("switch", { name: "Enable Grok Bot" }));
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).not.toBeChecked();
  });

  it("puts the switch back and explains when the server refuses", async () => {
    using _server = useAddonServer({ refuse: true });
    await using _screen = await render(<AddonsSettingsPanel />);
    await expect.poll(() => addonCalls()).toBe(1);
    await userEvent.click(page.getByRole("switch", { name: "Enable Grok Bot" }));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("switch", { name: "Enable Grok Bot" })).not.toBeChecked();
  });
});
