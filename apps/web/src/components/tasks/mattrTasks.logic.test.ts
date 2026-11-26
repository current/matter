import type { MattrTask, ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyTaskMoves,
  describeTaskDueDate,
  groupTasksByStatus,
  isTaskOverdue,
  listViewTasks,
  planTaskMove,
  taskPrompt,
} from "./mattrTasks.logic";
import { resolveTaskAgentChoice, taskModelSelection } from "./taskAgent";

const task = (overrides: Partial<MattrTask> & Pick<MattrTask, "id">): MattrTask => ({
  title: overrides.id,
  note: "",
  status: "todo",
  order: 0,
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
  ...overrides,
});

const board = [
  task({ id: "a", order: 0 }),
  task({ id: "b", order: 1 }),
  task({ id: "c", order: 2 }),
  task({ id: "p", status: "in_progress", order: 0 }),
  task({ id: "d", status: "done", order: 0, completedAt: "2026-11-02T00:00:00.000Z" }),
];

describe("planTaskMove", () => {
  it("places a task between its new neighbours", () => {
    expect(planTaskMove(board, "c", "todo", "b")).toEqual({ id: "c", status: "todo", order: 0.5 });
  });

  it("appends to the end of another column", () => {
    expect(planTaskMove(board, "a", "in_progress", null)).toEqual({
      id: "a",
      status: "in_progress",
      order: 1,
    });
  });

  it("goes before the first card and into empty columns", () => {
    expect(planTaskMove(board, "b", "todo", "a")).toEqual({ id: "b", status: "todo", order: -1 });
    expect(planTaskMove(board, "a", "in_review", null)).toEqual({
      id: "a",
      status: "in_review",
      order: 0,
    });
  });

  it("returns null when the task would not move", () => {
    expect(planTaskMove(board, "b", "todo", "c")).toBeNull();
    expect(planTaskMove(board, "c", "todo", null)).toBeNull();
    expect(planTaskMove(board, "a", "todo", "a")).toBeNull();
    expect(planTaskMove(board, "missing", "todo", null)).toBeNull();
  });
});

describe("applyTaskMoves", () => {
  it("stamps completion moving into done and clears it moving out", () => {
    const now = "2026-11-26T12:00:00.000Z";
    const moved = applyTaskMoves(
      board,
      [
        { id: "a", status: "done", order: 1 },
        { id: "d", status: "todo", order: 5 },
      ],
      now,
    );
    expect(moved.find((entry) => entry.id === "a")).toMatchObject({
      status: "done",
      completedAt: now,
    });
    expect(moved.find((entry) => entry.id === "d")).toMatchObject({
      status: "todo",
      completedAt: null,
    });
    expect(groupTasksByStatus(moved).todo.map((entry) => entry.id)).toEqual(["b", "c", "d"]);
  });
});

describe("list view", () => {
  it("keeps finished tasks out unless asked, newest first", () => {
    const tasks = [...board, task({ id: "e", status: "done", completedAt: "2026-11-03" })];
    expect(listViewTasks(tasks, false)).toMatchObject({ completed: [], completedCount: 2 });
    expect(listViewTasks(tasks, false).open.map((entry) => entry.id)).toEqual(["a", "b", "c", "p"]);
    expect(listViewTasks(tasks, true).completed.map((entry) => entry.id)).toEqual(["e", "d"]);
  });
});

describe("taskPrompt", () => {
  it("adds the note under the title only when there is one", () => {
    expect(taskPrompt({ title: "Fix login", note: "  " })).toBe("Fix login");
    expect(taskPrompt({ title: "Fix login", note: "Safari only\n" })).toBe(
      "Fix login\n\nSafari only",
    );
  });
});

describe("due dates", () => {
  const today = new Date(2026, 10, 26);
  it("names nearby days and flags overdue open tasks", () => {
    expect(describeTaskDueDate("2026-11-26", today).relativeDays).toBe(0);
    expect(describeTaskDueDate("2026-11-27", today).relativeDays).toBe(1);
    expect(describeTaskDueDate("2026-11-25", today).relativeDays).toBe(-1);
    expect(describeTaskDueDate("2026-12-24", today).relativeDays).toBeNull();
    expect(isTaskOverdue({ dueDate: "2026-11-20", status: "todo" }, today)).toBe(true);
    expect(isTaskOverdue({ dueDate: "2026-11-20", status: "done" }, today)).toBe(false);
    expect(isTaskOverdue({ dueDate: "2026-11-26", status: "todo" }, today)).toBe(false);
  });
});

const provider = (instanceId: string, overrides: Partial<ServerProvider> = {}) =>
  ({
    instanceId,
    driver: "claudeAgent",
    displayName: instanceId,
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "authenticated" },
    models: [
      {
        slug: "small",
        name: "Small",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "big",
        name: "Big",
        isCustom: false,
        isDefault: true,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High", isDefault: true },
              ],
            },
          ],
        },
      },
    ],
    ...overrides,
  }) as unknown as ServerProvider;

describe("resolveTaskAgentChoice", () => {
  const providers = [provider("off", { enabled: false }), provider("main"), provider("alt")];

  it("keeps the task's own pick, falling back to the project default, then the first usable", () => {
    const own = resolveTaskAgentChoice({
      providers,
      providerInstanceId: "alt",
      model: "small",
      effort: null,
      defaultSelection: null,
    });
    expect([own?.provider.instanceId, own?.model.slug, own?.effortChoices]).toEqual([
      "alt",
      "small",
      [],
    ]);
    const fromDefault = resolveTaskAgentChoice({
      providers,
      providerInstanceId: "off",
      model: null,
      effort: null,
      defaultSelection: { instanceId: "alt" as never, model: "big" },
    });
    expect(fromDefault?.provider.instanceId).toBe("alt");
    const first = resolveTaskAgentChoice({
      providers,
      providerInstanceId: null,
      model: null,
      effort: null,
      defaultSelection: null,
    });
    expect([first?.provider.instanceId, first?.model.slug, first?.effort]).toEqual([
      "main",
      "big",
      "high",
    ]);
  });

  it("sends the chosen effort as the model's reasoning option", () => {
    const choice = resolveTaskAgentChoice({
      providers,
      providerInstanceId: "main",
      model: "big",
      effort: "low",
      defaultSelection: null,
    });
    expect(choice && taskModelSelection(choice)).toEqual({
      instanceId: "main",
      model: "big",
      options: [{ id: "effort", value: "low" }],
    });
  });
});
