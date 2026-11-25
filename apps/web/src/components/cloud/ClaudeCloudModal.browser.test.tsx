import { render } from "../../../test/render";
import { MATTR_ADDON_MANIFESTS, type AddonEntry } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));

vi.mock(import("../../addons/mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => config,
}));

import { closeClaudeCloudDialog, openClaudeCloudDialog } from "../../addons/claudeCloudApi";
import { loadAddons, resetAddonStoreForTests } from "../../addons/addonStore";
import { ClaudeCloudModalHost } from "./ClaudeCloudModal";

const CLOUD_ID = "cse_01ABCDEFGH1234";

const entries = (cloudEnabled: boolean): ReadonlyArray<AddonEntry> =>
  MATTR_ADDON_MANIFESTS.map((manifest) => {
    const on = manifest.id === "claude-cloud" && cloudEnabled;
    return {
      manifest,
      state: {
        id: manifest.id,
        enabled: on,
        enablementSource: on ? "user" : "default",
        updatedAt: null,
        status: on ? { kind: "connected" } : { kind: "disabled" },
      },
    };
  });

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let cloudEnabled = false;
const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
  const url = new URL(String(input));
  if (url.pathname === "/api/mattr/addons") return json({ addons: entries(cloudEnabled) });
  if (url.pathname === "/api/mattr/claude-cloud/followup") {
    const body = JSON.parse(String(init?.body)) as { sessionId: string; prompt: string };
    return json({ sessionId: body.sessionId, reply: `Still running: ${body.prompt}` });
  }
  return json({ error: "not_found" }, 404);
});

async function useAddons(enabled: boolean): Promise<Disposable> {
  cloudEnabled = enabled;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.removeItem("mattr:addons:v1");
  resetAddonStoreForTests();
  await loadAddons(config);
  return {
    [Symbol.dispose]: () => {
      closeClaudeCloudDialog();
      vi.unstubAllGlobals();
      window.localStorage.removeItem("mattr:addons:v1");
      resetAddonStoreForTests();
    },
  };
}

describe("ClaudeCloudModalHost", () => {
  it("renders nothing while the add-on is off, even when asked to open", async () => {
    using _addons = await useAddons(false);
    await using _screen = await render(<ClaudeCloudModalHost />);
    openClaudeCloudDialog({ mode: "launch" });
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([input]) => String(input).includes("/claude-cloud")),
    ).toEqual([]);
  });

  it("sends a follow-up to a session pasted as a claude.ai link and shows the reply", async () => {
    using _addons = await useAddons(true);
    await using _screen = await render(<ClaudeCloudModalHost />);
    openClaudeCloudDialog({ mode: "followup" });
    await expect.element(page.getByRole("dialog")).toBeVisible();

    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect.element(send).toBeDisabled();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Session" }),
      `https://claude.ai/code/${CLOUD_ID}`,
    );
    await userEvent.fill(page.getByRole("textbox", { name: "Message" }), "How is it going?");
    await userEvent.click(send);

    await expect.element(page.getByText("Still running: How is it going?")).toBeVisible();
    const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/followup"));
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      sessionId: CLOUD_ID,
      prompt: "How is it going?",
    });
  });
});
