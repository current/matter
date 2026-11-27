import { render } from "../../../test/render";
import {
  EnvironmentId,
  MATTER_ADDON_MANIFESTS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AddonEntry,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const TELEPORTED_THREAD_ID = ThreadId.make("thread-teleported");
const ENVIRONMENT_ID = EnvironmentId.make("primary");

const config = vi.hoisted(() => ({ baseUrl: "http://server.test", headers: {} }));
const navState = vi.hoisted(() => ({ navigate: vi.fn(async () => {}) }));

vi.mock(import("../../addons/matterApi"), async (original) => ({
  ...(await original()),
  useMatterApiConfig: () => config,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => ENVIRONMENT_ID,
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [
    {
      id: PROJECT_ID,
      environmentId: ENVIRONMENT_ID,
      title: "Matter",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      createdAt: "2026-03-01T00:00:00.000Z",
      updatedAt: "2026-03-01T00:00:00.000Z",
      scripts: [],
    },
  ],
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: () => navState.navigate,
}));

import { closeClaudeCloudDialog, openClaudeCloudDialog } from "../../addons/claudeCloudApi";
import { loadAddons, resetAddonStoreForTests } from "../../addons/addonStore";
import { ClaudeCloudModalHost } from "./ClaudeCloudModal";

const CLOUD_ID = "cse_01ABCDEFGH1234";

const entries = (cloudEnabled: boolean): ReadonlyArray<AddonEntry> =>
  MATTER_ADDON_MANIFESTS.map((manifest) => {
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
  if (url.pathname === "/api/mattr/claude-cloud/eligibility") {
    return json({
      account: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        displayName: "Claude",
        ready: true,
        checkedAt: "2026-11-27T09:00:00.000Z",
      },
      repository: {
        cwd: "/repo",
        githubRemote: "current/matter",
        branch: "main",
        hasUpstream: true,
        aheadCount: 0,
        dirty: false,
      },
      blockers: [],
      warnings: [],
    });
  }
  if (url.pathname === "/api/mattr/claude-cloud/launch") {
    return json({
      session: {
        id: CLOUD_ID,
        url: `https://claude.ai/code/${CLOUD_ID}`,
        title: "Cloud run",
        promptPreview: "Run tests",
        instanceId: ProviderInstanceId.make("claudeAgent"),
        projectId: PROJECT_ID,
        cwd: "/repo",
        branch: "main",
        createdBy: "user",
        sourceThreadId: THREAD_ID,
        reason: null,
        createdAt: "2026-11-27T09:00:00.000Z",
        lastMessageAt: null,
        lastReplyPreview: null,
        teleportedThreadId: null,
        teleportedWorktreePath: null,
      },
      pushed: false,
      warnings: [],
    });
  }
  if (url.pathname === "/api/mattr/claude-cloud/teleport") {
    return json({
      sessionId: CLOUD_ID,
      worktreePath: "/repo/.worktrees/cloud",
      branch: "fix/cloud",
      threadId: TELEPORTED_THREAD_ID,
    });
  }
  if (url.pathname === "/api/mattr/claude-cloud/followup") {
    const body = JSON.parse(String(init?.body)) as { sessionId: string; prompt: string };
    return json({ sessionId: body.sessionId, reply: `Still running: ${body.prompt}` });
  }
  return json({ error: "not_found" }, 404);
});

async function useAddons(enabled: boolean): Promise<Disposable> {
  cloudEnabled = enabled;
  fetchMock.mockClear();
  navState.navigate.mockClear();
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

  it("shows the report-back note and sends threadId when launched from a chat", async () => {
    using _addons = await useAddons(true);
    await using _screen = await render(<ClaudeCloudModalHost />);
    openClaudeCloudDialog({ mode: "launch", projectId: PROJECT_ID, threadId: THREAD_ID });
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect
      .element(page.getByText("Matter will post the result in this chat when the run ends."))
      .toBeVisible();

    await userEvent.fill(page.getByRole("textbox", { name: "Message" }), "Run the full suite");
    const launch = page.getByRole("button", { name: "Launch", exact: true });
    await expect.element(launch).toBeEnabled();
    await userEvent.click(launch);

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(([input]) => String(input).endsWith("/launch"));
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        prompt: "Run the full suite",
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
      });
    });
  });

  it("navigates to the resulting thread after teleport succeeds", async () => {
    using _addons = await useAddons(true);
    await using _screen = await render(<ClaudeCloudModalHost />);
    openClaudeCloudDialog({
      mode: "teleport",
      sessionId: CLOUD_ID,
      projectId: PROJECT_ID,
    });
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Teleport", exact: true }));

    await vi.waitFor(() =>
      expect(navState.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: ENVIRONMENT_ID, threadId: TELEPORTED_THREAD_ID },
      }),
    );
  });
});
