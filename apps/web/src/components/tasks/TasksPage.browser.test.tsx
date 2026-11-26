import { render } from "../../../test/render";
import {
  DEFAULT_SERVER_SETTINGS,
  type MattrTask,
  type MattrTaskMove,
  type ServerProvider,
} from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import "../../../../../antimatter/tasks.css";

const mocks = vi.hoisted(() => ({
  config: { baseUrl: "http://server.test", headers: {} },
  startTaskThread: vi.fn(async (_input: unknown) => ({
    environmentId: "env-1",
    threadId: "thread-1",
  })),
}));

vi.mock(import("../../addons/mattrApi"), async (original) => ({
  ...(await original()),
  useMattrApiConfig: () => mocks.config,
}));

vi.mock(import("../MattrInsetPage"), () => ({
  MattrInsetPage: ({
    breadcrumb,
    actions,
    children,
  }: {
    breadcrumb: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
  }) => (
    <div>
      <header>
        {breadcrumb}
        {actions}
      </header>
      {children}
    </div>
  ),
}));

const project = {
  id: "project-1",
  environmentId: "env-1",
  title: "mattr",
  workspaceRoot: "/tmp/mattr",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

const provider = {
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  displayName: "Claude",
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  models: [{ slug: "opus", name: "Opus", isCustom: false, isDefault: true, capabilities: null }],
} as unknown as ServerProvider;

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => "env-1" as never,
  useEnvironmentProviders: () => new Map([["env-1" as never, [provider]]]),
}));

vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: () => [project] as never,
  useQuietThreadShell: () => null,
}));

vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: () => DEFAULT_SERVER_SETTINGS as never,
}));

vi.mock(import("./useStartTaskThread"), () => ({
  useStartTaskThread: () => mocks.startTaskThread as never,
}));

import { resetMattrTasksStoreForTests } from "./mattrTasksStore";
import { TasksPage } from "./TasksPage";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const realFetch = globalThis.fetch;

function useTasksServer(initial: ReadonlyArray<Partial<MattrTask> & { title: string }> = []) {
  let next = 0;
  const make = (input: Partial<MattrTask> & { title: string }): MattrTask => {
    next += 1;
    return {
      id: `task-${next}`,
      note: "",
      status: "todo",
      order: next,
      projectId: null,
      dueDate: null,
      priority: "none",
      providerInstanceId: null,
      model: null,
      effort: null,
      workspaceMode: "local",
      interactionMode: "default",
      linkedThreadRef: null,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      completedAt: null,
      ...input,
    };
  };
  const server = { tasks: initial.map(make), patches: [] as unknown[], moves: [] as unknown[] };
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.startsWith("/api/mattr/tasks")) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const id = decodeURIComponent(url.pathname.split("/")[4] ?? "");
    if (method === "GET") return json({ tasks: server.tasks });
    if (method === "POST" && id === "reorder") {
      server.moves.push(body);
      for (const move of body.moves as MattrTaskMove[]) {
        server.tasks = server.tasks.map((entry) =>
          entry.id === move.id ? { ...entry, status: move.status, order: move.order } : entry,
        );
      }
      return json({ tasks: server.tasks });
    }
    if (method === "POST") {
      const created = make(body);
      server.tasks = [...server.tasks, created];
      return json({ task: created });
    }
    if (method === "PATCH") {
      server.patches.push(body);
      server.tasks = server.tasks.map((entry) => (entry.id === id ? { ...entry, ...body } : entry));
      return json({ task: server.tasks.find((entry) => entry.id === id) });
    }
    if (method === "DELETE") {
      server.tasks = server.tasks.filter((entry) => entry.id !== id);
      return json({ ok: true });
    }
    return new Response(null, { status: 404 });
  });
  resetMattrTasksStoreForTests();
  mocks.startTaskThread.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  try {
    window.localStorage.removeItem("mattr:tasks:view:v1");
  } catch {}
  return Object.assign(server, { [Symbol.dispose]: () => vi.unstubAllGlobals() });
}

describe("TasksPage", () => {
  it("adds tasks inline with Enter and checks them off", async () => {
    using server = useTasksServer([{ title: "Existing task" }]);
    await using _screen = await render(<TasksPage />);

    await expect.element(page.getByText("Existing task")).toBeVisible();
    await expect.element(page.getByText("1 to do").first()).toBeVisible();

    const input = page.getByRole("textbox", { name: "New task" });
    await userEvent.click(input);
    await userEvent.keyboard("Write the release notes{Enter}");
    await expect.element(page.getByText("Write the release notes")).toBeVisible();
    await expect.element(input).toHaveValue("");
    await expect.element(input).toHaveFocus();
    expect(server.tasks.map((entry) => entry.title)).toEqual([
      "Existing task",
      "Write the release notes",
    ]);

    await userEvent.click(page.getByRole("checkbox", { name: "Mark as done" }).first());
    await expect.element(page.getByText("Existing task")).not.toBeInTheDocument();
    await expect.element(page.getByRole("button", { name: "Show completed (1)" })).toBeVisible();
    expect(server.patches).toContainEqual({ status: "done" });
  });

  it("hands a task to an agent with Tab and links the started thread", async () => {
    using server = useTasksServer();
    await using _screen = await render(<TasksPage />);

    await userEvent.click(page.getByRole("textbox", { name: "New task" }));
    await userEvent.keyboard("Fix the flaky login test");
    await userEvent.keyboard("{Tab}");

    const start = page.getByRole("button", { name: "Start", exact: true });
    await expect.element(start).toHaveFocus();
    await expect
      .element(page.getByRole("textbox", { name: "Task title" }))
      .toHaveValue("Fix the flaky login test");

    await userEvent.fill(page.getByRole("textbox", { name: "Note" }), "Only on Safari.");
    await userEvent.click(page.getByRole("textbox", { name: "Task title" }));
    await expect.poll(() => server.patches).toContainEqual({ note: "Only on Safari." });

    await userEvent.click(page.getByRole("button", { name: "Project" }).last());
    await userEvent.click(page.getByRole("menuitemradio", { name: "mattr" }));
    await expect.poll(() => server.patches).toContainEqual({ projectId: "project-1" });

    await userEvent.click(start);
    await expect.poll(() => mocks.startTaskThread.mock.calls.length).toBe(1);
    expect(mocks.startTaskThread.mock.calls[0]?.[0]).toMatchObject({
      title: "Fix the flaky login test",
      prompt: "Fix the flaky login test\n\nOnly on Safari.",
      modelSelection: { instanceId: "claudeAgent", model: "opus" },
      workspaceMode: "local",
      interactionMode: "default",
    });
    await expect
      .poll(() => server.tasks[0])
      .toMatchObject({
        status: "in_progress",
        linkedThreadRef: { environmentId: "env-1", threadId: "thread-1" },
      });
  });

  it("shows the board and moves a card to the next column from the keyboard", async () => {
    using server = useTasksServer([
      { title: "Ship tasks" },
      { title: "Review PR", status: "in_review" },
    ]);
    await using _screen = await render(<TasksPage />);

    await userEvent.click(page.getByRole("radio", { name: "Kanban" }));
    for (const column of ["To Do", "In Progress", "In Review", "Done"]) {
      await expect.element(page.getByRole("region", { name: column })).toBeVisible();
    }
    const card = page.getByRole("button", { name: "Ship tasks" });
    await userEvent.click(card);
    await expect.element(page.getByRole("complementary", { name: "Task details" })).toBeVisible();
    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");

    await expect
      .poll(() => server.tasks.find((entry) => entry.title === "Ship tasks")?.status)
      .toBe("in_progress");
    await expect
      .element(
        page
          .getByRole("region", { name: "In Progress" })
          .getByRole("button", { name: "Ship tasks" }),
      )
      .toBeVisible();
    await expect
      .element(
        page
          .getByRole("region", { name: "In Progress" })
          .getByRole("button", { name: "Ship tasks" }),
      )
      .toHaveFocus();

    await userEvent.keyboard("{Alt>}{ArrowRight}{/Alt}");
    await expect
      .poll(() => server.tasks.find((entry) => entry.title === "Ship tasks")?.status)
      .toBe("in_review");
    await expect
      .element(
        page.getByRole("region", { name: "In Review" }).getByRole("button", { name: "Ship tasks" }),
      )
      .toHaveFocus();
    expect(window.localStorage.getItem("mattr:tasks:view:v1")).toBe("kanban");
  });

  it("saves a title still being typed when Escape closes the inspector", async () => {
    using server = useTasksServer([{ title: "Draft title" }]);
    await using _screen = await render(<TasksPage />);

    await userEvent.click(page.getByRole("button", { name: "Draft title" }));
    const title = page.getByRole("textbox", { name: "Task title" });
    await userEvent.fill(title, "Final title");
    await userEvent.keyboard("{Escape}");

    await expect
      .element(page.getByRole("complementary", { name: "Task details" }))
      .not.toBeInTheDocument();
    await expect.poll(() => server.patches).toContainEqual({ title: "Final title" });
    await expect.element(page.getByText("Final title")).toBeVisible();
  });
});
