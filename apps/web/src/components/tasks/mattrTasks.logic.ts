import { type MattrTask, type MattrTaskMove, type MattrTaskStatus } from "@t3tools/contracts";

const STATUS_RANK: Record<MattrTaskStatus, number> = {
  todo: 0,
  in_progress: 1,
  in_review: 2,
  done: 3,
};

export function sortTasks(tasks: ReadonlyArray<MattrTask>): MattrTask[] {
  return tasks.toSorted(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      a.order - b.order ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function groupTasksByStatus(
  tasks: ReadonlyArray<MattrTask>,
): Record<MattrTaskStatus, MattrTask[]> {
  const groups: Record<MattrTaskStatus, MattrTask[]> = {
    todo: [],
    in_progress: [],
    in_review: [],
    done: [],
  };
  for (const task of sortTasks(tasks)) groups[task.status].push(task);
  return groups;
}

/** The list view: every open task first, then finished ones, each in board order. */
export function listViewTasks(tasks: ReadonlyArray<MattrTask>, showCompleted: boolean) {
  const sorted = sortTasks(tasks);
  return {
    open: sorted.filter((task) => task.status !== "done"),
    completed: showCompleted
      ? sorted
          .filter((task) => task.status === "done")
          .toSorted((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? ""))
      : [],
    completedCount: sorted.filter((task) => task.status === "done").length,
  };
}

export function openTaskCount(tasks: ReadonlyArray<MattrTask>): number {
  return tasks.filter((task) => task.status !== "done").length;
}

/**
 * Moves `taskId` into `status` before `beforeId` (or to the end), giving it an order between its
 * new neighbours so only the moved task changes. Returns null when nothing would move.
 */
export function planTaskMove(
  tasks: ReadonlyArray<MattrTask>,
  taskId: string,
  status: MattrTaskStatus,
  beforeId: string | null,
): MattrTaskMove | null {
  const task = tasks.find((candidate) => candidate.id === taskId);
  if (!task || beforeId === taskId) return null;
  const column = groupTasksByStatus(tasks)[status].filter((candidate) => candidate.id !== taskId);
  const index =
    beforeId === null ? column.length : column.findIndex((candidate) => candidate.id === beforeId);
  const insertAt = index === -1 ? column.length : index;
  const previous = column[insertAt - 1];
  const next = column[insertAt];
  const order =
    previous && next
      ? (previous.order + next.order) / 2
      : previous
        ? previous.order + 1
        : next
          ? next.order - 1
          : 0;
  if (task.status === status) {
    const current = groupTasksByStatus(tasks)[status];
    const currentIndex = current.findIndex((candidate) => candidate.id === taskId);
    if (
      current[currentIndex - 1]?.id === previous?.id &&
      current[currentIndex + 1]?.id === next?.id
    ) {
      return null;
    }
  }
  return { id: taskId, status, order };
}

/** Applies moves the way the server does, so a drag shows its result before the reply. */
export function applyTaskMoves(
  tasks: ReadonlyArray<MattrTask>,
  moves: ReadonlyArray<MattrTaskMove>,
  now: string,
): MattrTask[] {
  const byId = new Map(moves.map((move) => [move.id, move]));
  return tasks.map((task) => {
    const move = byId.get(task.id);
    if (!move) return task;
    return {
      ...task,
      status: move.status,
      order: move.order,
      updatedAt: now,
      completedAt:
        move.status === "done" ? (task.status === "done" ? task.completedAt : now) : null,
    };
  });
}

/** The opening prompt a task hands its agent: the title, then the note when there is one. */
export function taskPrompt(task: Pick<MattrTask, "title" | "note">): string {
  const note = task.note.trim();
  return note.length === 0 ? task.title : `${task.title}\n\n${note}`;
}

export type MattrTaskThreadState = "running" | "needs" | "done" | "failed" | "idle";

/** Days from today (-1, 0, 1) when the date is that close, else null, plus a short label. */
export function describeTaskDueDate(
  dueDate: string,
  today: Date,
): { readonly relativeDays: -1 | 0 | 1 | null; readonly label: string } {
  const [year, month, day] = dueDate.split("-").map(Number);
  if (!year || !month || !day) return { relativeDays: null, label: dueDate };
  const due = new Date(year, month - 1, day);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((due.getTime() - start.getTime()) / 86_400_000);
  const label = due.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(due.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
  return { relativeDays: days === -1 || days === 0 || days === 1 ? days : null, label };
}

export function localIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function isTaskOverdue(task: Pick<MattrTask, "dueDate" | "status">, today: Date) {
  if (task.dueDate === null || task.status === "done") return false;
  return task.dueDate < localIsoDate(today);
}
