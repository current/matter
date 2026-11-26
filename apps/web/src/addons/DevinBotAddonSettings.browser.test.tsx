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

import { DevinBotAddonSettings } from "./DevinBotAddonSettings";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;

describe("DevinBotAddonSettings", () => {
  let savedConfig: Record<string, unknown>;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname !== "/api/mattr/addons/config") return realFetch(input, init);
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { config: Record<string, unknown> };
      savedConfig = { ...savedConfig, ...body.config };
    }
    return json({ id: "devin-bot", config: savedConfig });
  });

  function useConfigServer(): Disposable {
    savedConfig = {};
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    return { [Symbol.dispose]: () => vi.unstubAllGlobals() };
  }

  const renderCard = (status: AddonRuntimeStatus, onReconnect = vi.fn(async () => {})) =>
    render(
      <DevinBotAddonSettings status={status} busy={false} canWrite onReconnect={onReconnect} />,
    );

  it("shows the debug port, launch command, disclosure and warning, and tests the port", async () => {
    using _server = useConfigServer();
    const onReconnect = vi.fn(async () => {});
    await using _screen = await renderCard(
      { kind: "enabled_unconfigured", detail: "Devin isn't reachable on debug port 9223." },
      onReconnect,
    );

    const port = page.getByRole("spinbutton", { name: "Debug port" });
    await expect.element(port).toHaveValue(9223);
    await expect
      .element(
        page.getByText(
          'open -a "Devin" --args --remote-debugging-port=9223 --remote-debugging-address=127.0.0.1',
        ),
      )
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect
      .element(page.getByText("Matter never opens, quits or restarts Devin", { exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByText("any app running as your user on this Mac", { exact: false }))
      .toBeVisible();

    await userEvent.fill(port, "9444");
    await expect
      .element(page.getByText("--remote-debugging-port=9444", { exact: false }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Test connection" }));

    await expect.poll(() => onReconnect.mock.calls.length).toBe(1);
    expect(savedConfig).toEqual({ cdpPort: 9444 });
  });

  it("hides the launch command once connected but keeps the security warning", async () => {
    using _server = useConfigServer();
    await using screen = await renderCard({ kind: "connected" });

    await expect
      .element(page.getByText("any app running as your user on this Mac", { exact: false }))
      .toBeVisible();
    expect(screen.container.querySelector("[data-devin-bot-command]")).toBeNull();
  });

  it("asks to install Devin when the app is missing", async () => {
    using _server = useConfigServer();
    await using screen = await renderCard({ kind: "app_unavailable" });

    await expect
      .element(page.getByText("Install Devin on this Mac, then test the connection."))
      .toBeVisible();
    expect(screen.container.querySelector("[data-devin-bot-command]")).toBeNull();
  });
});
