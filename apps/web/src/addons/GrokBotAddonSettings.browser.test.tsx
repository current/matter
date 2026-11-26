import { render } from "../../test/render";
import type { AddonRuntimeStatus } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../index.css";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("./matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => config,
}));

import { GrokBotAddonSettings } from "./GrokBotAddonSettings";

const realFetch = globalThis.fetch;

function useConfigServer(): Disposable {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/mattr/addons/config") return realFetch(input, init);
      return new Response(JSON.stringify({ id: "grok-bot", config: {} }), {
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

const renderCard = (status: AddonRuntimeStatus, onReconnect = vi.fn(async () => {})) =>
  render(<GrokBotAddonSettings status={status} busy={false} canWrite onReconnect={onReconnect} />);

describe("GrokBotAddonSettings", () => {
  it("shows the live connection and hides the launch command once connected", async () => {
    using _server = useConfigServer();
    await using screen = await renderCard({
      kind: "connected",
      detail: "Grok Bot 1.3.0 · 3 Bots",
    });

    await expect.element(page.getByRole("status")).toHaveTextContent("Grok Bot 1.3.0 · 3 Bots");
    await expect.element(page.getByRole("button", { name: "Test connection" })).toBeVisible();
    expect(screen.container.querySelector("[data-grok-bot-command]")).toBeNull();
  });

  it("offers the launch command while disconnected and reports a failed test", async () => {
    using _server = useConfigServer();
    const onReconnect = vi.fn(async () => {});
    await using _screen = await renderCard(
      { kind: "disconnected", detail: "Grok Bot isn't reachable on debug port 9222." },
      onReconnect,
    );

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("Grok Bot isn't reachable on debug port 9222.");
    await expect
      .element(page.getByText('open -a "Grok Bot" --args --remote-debugging-port=9222'))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy command" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Test connection" }));
    await expect.poll(() => onReconnect.mock.calls.length).toBe(1);
    await expect.element(page.getByText("Couldn't connect.", { exact: false })).toBeVisible();
  });
});
