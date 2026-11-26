/* oxlint-disable shadcn/no-unknown-classes -- the `mtk-*` classes come from the fork stylesheet antimatter/tasks.css, which loads outside Tailwind. */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  MATTR_TASK_STATUSES,
  MATTR_TASK_TITLE_MAX_LENGTH,
  type MattrTask,
  type MattrTaskCreateRequest,
  type MattrTaskStatus,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { CheckIcon, PlusIcon } from "lucide-react";
import { useRef, useState, type DragEvent, type KeyboardEvent } from "react";
import { flushSync } from "react-dom";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { MattrInsetPage } from "../MattrInsetPage";
import { toastManager } from "../ui/toast";
import { WorkspaceBreadcrumbText } from "../WorkspaceBreadcrumb";
import {
  describeTaskDueDate,
  groupTasksByStatus,
  isTaskOverdue,
  listViewTasks,
  openTaskCount,
  planTaskMove,
} from "./mattrTasks.logic";
import { createMattrTasksActions, type MattrTasksActions, useMattrTasks } from "./mattrTasksStore";
import { TaskInspector, usePriorityLabel } from "./TaskInspector";
import { useTaskStatusLabel } from "./TaskStatusLabel";
import { TaskThreadChip, useOpenTaskThread } from "./TaskThreadChip";

type TasksView = "list" | "kanban";
const VIEW_STORAGE_KEY = "mattr:tasks:view:v1";

function readView(): TasksView {
  try {
    return window.localStorage.getItem(VIEW_STORAGE_KEY) === "kanban" ? "kanban" : "list";
  } catch {
    return "list";
  }
}

function writeView(view: TasksView) {
  try {
    window.localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage can be unavailable (private mode); the view just resets next time.
  }
}

export function TasksPage() {
  const gt = useGT();
  const { config, tasks, loaded, error } = useMattrTasks();
  const environmentId = usePrimaryEnvironmentId();
  const projects = useProjects().filter(
    (project) =>
      project.environmentId === environmentId && !project.isScratch && !project.archivedAt,
  );
  const [view, setView] = useState<TasksView>(readView);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const startRef = useRef<HTMLButtonElement>(null);
  const actions = config ? createMattrTasksActions(config) : null;
  const selected = tasks.find((task) => task.id === selectedId) ?? null;
  const remaining = openTaskCount(tasks);

  const changeView = (next: TasksView) => {
    setView(next);
    writeView(next);
  };

  const selectAndHandOff = (task: MattrTask) => {
    flushSync(() => setSelectedId(task.id));
    startRef.current?.focus();
  };

  return (
    <MattrInsetPage
      label={gt("Tasks")}
      breadcrumb={
        <WorkspaceBreadcrumbText className="mtk-crumb">
          {gt("Tasks")}
          {loaded ? (
            <span className="mtk-crumb-count">{gt("{count} to do", { count: remaining })}</span>
          ) : null}
        </WorkspaceBreadcrumbText>
      }
      actions={
        <div className="mtk-view-toggle" role="radiogroup" aria-label={gt("Tasks view")}>
          <button
            type="button"
            role="radio"
            aria-checked={view === "list"}
            onClick={() => changeView("list")}
          >
            {gt("List", { $context: "tasks view" })}
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={view === "kanban"}
            onClick={() => changeView("kanban")}
          >
            {gt("Kanban", { $context: "tasks board view" })}
          </button>
        </div>
      }
    >
      <div
        className="mtk"
        data-view={view}
        data-inspector={selected ? "open" : undefined}
        onKeyDown={(event) => {
          if (
            event.key === "Escape" &&
            selected &&
            !event.defaultPrevented &&
            event.currentTarget.contains(event.target as Node)
          ) {
            event.preventDefault();
            setSelectedId(null);
          }
        }}
      >
        {!actions ? null : view === "list" ? (
          <TaskListView
            tasks={tasks}
            loaded={loaded}
            error={error}
            remaining={remaining}
            projects={projects}
            actions={actions}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            onHandOff={selectAndHandOff}
          />
        ) : (
          <TaskBoardView
            tasks={tasks}
            projects={projects}
            actions={actions}
            selectedId={selected?.id ?? null}
            onSelect={setSelectedId}
            onHandOff={selectAndHandOff}
          />
        )}
        {selected && actions && environmentId ? (
          <TaskInspector
            key={selected.id}
            environmentId={environmentId}
            task={selected}
            projects={projects}
            actions={actions}
            onClose={() => setSelectedId(null)}
            startRef={startRef}
          />
        ) : null}
      </div>
    </MattrInsetPage>
  );
}

function useCreateTask(actions: MattrTasksActions) {
  const gt = useGT();
  return async (input: MattrTaskCreateRequest) => {
    try {
      return await actions.create(input);
    } catch {
      toastManager.add({ type: "error", title: gt("Could not add the task") });
      return null;
    }
  };
}

function TaskListView({
  tasks,
  loaded,
  error,
  remaining,
  projects,
  actions,
  selectedId,
  onSelect,
  onHandOff,
}: {
  readonly tasks: ReadonlyArray<MattrTask>;
  readonly loaded: boolean;
  readonly error: string | null;
  readonly remaining: number;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly actions: MattrTasksActions;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onHandOff: (task: MattrTask) => void;
}) {
  const gt = useGT();
  const [showCompleted, setShowCompleted] = useState(false);
  const { open, completed, completedCount } = listViewTasks(tasks, showCompleted);
  return (
    <div className="mtk-scroll">
      <div className="mtk-list">
        <header className="mtk-list-head">
          <h1>{gt("Tasks")}</h1>
          <p className="mtk-sub">
            <span>{loaded ? gt("{count} to do", { count: remaining }) : gt("Loading…")}</span>
            {completedCount > 0 ? (
              <button
                type="button"
                className="mtk-link"
                aria-pressed={showCompleted}
                onClick={() => setShowCompleted((shown) => !shown)}
              >
                {showCompleted
                  ? gt("Hide completed")
                  : gt("Show completed ({count})", { count: completedCount })}
              </button>
            ) : null}
          </p>
          {error ? (
            <p className="mtk-error">{gt("Tasks could not load: {error}", { error })}</p>
          ) : null}
        </header>
        <ul className="mtk-rows" aria-label={gt("To do")}>
          {open.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              projects={projects}
              actions={actions}
              selected={task.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
        <TaskQuickAdd
          actions={actions}
          status="todo"
          placeholder={gt("Add a task, or press Tab to hand it to an agent")}
          onHandOff={onHandOff}
        />
        {completed.length > 0 ? (
          <ul className="mtk-rows mtk-rows-done" aria-label={gt("Completed")}>
            {completed.map((task) => (
              <TaskRow
                key={task.id}
                task={task}
                projects={projects}
                actions={actions}
                selected={task.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

function TaskCheck({
  task,
  actions,
}: {
  readonly task: MattrTask;
  readonly actions: MattrTasksActions;
}) {
  const gt = useGT();
  const done = task.status === "done";
  return (
    <button
      type="button"
      className="mtk-check"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? gt("Mark as not done") : gt("Mark as done")}
      onClick={(event) => {
        event.stopPropagation();
        void actions
          .update(task.id, { status: done ? "todo" : "done" })
          .catch(() => toastManager.add({ type: "error", title: gt("Could not save the task") }));
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {done ? <CheckIcon aria-hidden /> : null}
    </button>
  );
}

function TaskMeta({
  task,
  projects,
}: {
  readonly task: MattrTask;
  readonly projects: ReadonlyArray<EnvironmentProject>;
}) {
  const gt = useGT();
  const priorityLabel = usePriorityLabel();
  const project = projects.find((candidate) => candidate.id === task.projectId);
  const [today] = useState(() => new Date());
  const due = task.dueDate ? describeTaskDueDate(task.dueDate, today) : null;
  const dueLabel =
    due === null
      ? null
      : due.relativeDays === 0
        ? gt("Today")
        : due.relativeDays === 1
          ? gt("Tomorrow")
          : due.relativeDays === -1
            ? gt("Yesterday")
            : due.label;
  return (
    <span className="mtk-meta">
      {task.priority !== "none" ? (
        <span
          className="mtk-priority"
          data-priority={task.priority}
          aria-label={gt("Priority: {priority}", { priority: priorityLabel(task.priority) })}
        >
          {task.priority === "high" ? "!!!" : task.priority === "medium" ? "!!" : "!"}
        </span>
      ) : null}
      {dueLabel ? (
        <span className="mtk-chip" data-overdue={isTaskOverdue(task, today) ? "" : undefined}>
          {dueLabel}
        </span>
      ) : null}
      {project ? <span className="mtk-chip">{project.title}</span> : null}
      {task.linkedThreadRef ? <TaskThreadChip threadRef={task.linkedThreadRef} /> : null}
    </span>
  );
}

function TaskRow({
  task,
  projects,
  actions,
  selected,
  onSelect,
}: {
  readonly task: MattrTask;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly actions: MattrTasksActions;
  readonly selected: boolean;
  readonly onSelect: (id: string | null) => void;
}) {
  return (
    <li
      className="mtk-row"
      data-selected={selected ? "" : undefined}
      data-done={task.status === "done" ? "" : undefined}
    >
      <TaskCheck task={task} actions={actions} />
      <button
        type="button"
        className="mtk-row-main"
        aria-pressed={selected}
        onClick={() => onSelect(selected ? null : task.id)}
      >
        <span className="mtk-row-title">{task.title}</span>
      </button>
      <TaskMeta task={task} projects={projects} />
    </li>
  );
}

function TaskQuickAdd({
  actions,
  status,
  placeholder,
  onHandOff,
  autoFocus = false,
  onDismiss,
}: {
  readonly actions: MattrTasksActions;
  readonly status: MattrTaskStatus;
  readonly placeholder: string;
  readonly onHandOff: (task: MattrTask) => void;
  readonly autoFocus?: boolean;
  readonly onDismiss?: () => void;
}) {
  const gt = useGT();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const createTask = useCreateTask(actions);
  const submit = async (handOff: boolean) => {
    const trimmed = title.trim();
    if (trimmed.length === 0 || busy) return;
    setBusy(true);
    const task = await createTask({ title: trimmed, status });
    setBusy(false);
    if (!task) return;
    setTitle("");
    if (handOff) onHandOff(task);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter") {
      event.preventDefault();
      void submit(false);
    } else if (event.key === "Tab" && !event.shiftKey && title.trim().length > 0) {
      event.preventDefault();
      void submit(true);
    } else if (event.key === "Escape" && onDismiss) {
      event.preventDefault();
      onDismiss();
    }
  };
  return (
    <div className="mtk-add">
      <span className="mtk-add-ring" aria-hidden />
      <input
        className="mtk-add-input"
        aria-label={gt("New task")}
        placeholder={placeholder}
        value={title}
        maxLength={MATTR_TASK_TITLE_MAX_LENGTH}
        autoFocus={autoFocus}
        aria-busy={busy}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => {
          if (onDismiss && title.trim().length === 0) onDismiss();
        }}
      />
    </div>
  );
}

interface DropTarget {
  readonly status: MattrTaskStatus;
  readonly beforeId: string | null;
}

function TaskBoardView({
  tasks,
  projects,
  actions,
  selectedId,
  onSelect,
  onHandOff,
}: {
  readonly tasks: ReadonlyArray<MattrTask>;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly actions: MattrTasksActions;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onHandOff: (task: MattrTask) => void;
}) {
  const gt = useGT();
  const statusLabel = useTaskStatusLabel();
  const columns = groupTasksByStatus(tasks);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [addingTo, setAddingTo] = useState<MattrTaskStatus | null>(null);

  const move = (taskId: string, status: MattrTaskStatus, beforeId: string | null) => {
    const planned = planTaskMove(tasks, taskId, status, beforeId);
    if (!planned) return;
    void actions
      .move([planned])
      .catch(() => toastManager.add({ type: "error", title: gt("Could not move the task") }));
  };

  const targetFromPointer = (
    event: DragEvent<HTMLElement>,
    status: MattrTaskStatus,
  ): DropTarget => {
    const cards = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-task-id]")].filter(
      (card) => card.dataset.taskId !== dragId,
    );
    const before = cards.find((card) => {
      const rect = card.getBoundingClientRect();
      return event.clientY < rect.top + rect.height / 2;
    });
    return { status, beforeId: before?.dataset.taskId ?? null };
  };

  const moveByKeyboard = (event: KeyboardEvent<HTMLElement>, task: MattrTask) => {
    if (!event.altKey) return;
    const column = columns[task.status];
    const index = column.findIndex((candidate) => candidate.id === task.id);
    const statusIndex = MATTR_TASK_STATUSES.indexOf(task.status);
    let target: DropTarget | null = null;
    if (event.key === "ArrowUp" && index > 0) {
      target = { status: task.status, beforeId: column[index - 1]?.id ?? null };
    } else if (event.key === "ArrowDown" && index < column.length - 1) {
      target = { status: task.status, beforeId: column[index + 2]?.id ?? null };
    } else if (event.key === "ArrowLeft" && statusIndex > 0) {
      target = { status: MATTR_TASK_STATUSES[statusIndex - 1] ?? task.status, beforeId: null };
    } else if (event.key === "ArrowRight" && statusIndex < MATTR_TASK_STATUSES.length - 1) {
      target = { status: MATTR_TASK_STATUSES[statusIndex + 1] ?? task.status, beforeId: null };
    }
    if (!target) return;
    event.preventDefault();
    move(task.id, target.status, target.beforeId);
    // A move to another column remounts the card, so focus would drop to <body>.
    const board = event.currentTarget.closest<HTMLElement>(".mtk-board");
    requestAnimationFrame(() => {
      board
        ?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(task.id)}"] .mtk-card-title`)
        ?.focus();
    });
  };

  return (
    <div className="mtk-board" aria-label={gt("Task board")}>
      {MATTR_TASK_STATUSES.map((status) => {
        const column = columns[status];
        const isTarget = dragId !== null && dropTarget?.status === status;
        return (
          <section
            key={status}
            className="mtk-column"
            data-status={status}
            data-drop-target={isTarget ? "" : undefined}
            aria-label={statusLabel(status)}
            onDragOver={(event) => {
              if (dragId === null) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const next = targetFromPointer(event, status);
              if (next.status !== dropTarget?.status || next.beforeId !== dropTarget.beforeId) {
                setDropTarget(next);
              }
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropTarget((current) => (current?.status === status ? null : current));
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const id = dragId ?? event.dataTransfer.getData("text/plain");
              const target = targetFromPointer(event, status);
              setDragId(null);
              setDropTarget(null);
              if (id) move(id, target.status, target.beforeId);
            }}
          >
            <header className="mtk-column-head">
              <span className="mtk-column-dot" aria-hidden />
              <h2>{statusLabel(status)}</h2>
              <span className="mtk-count">{column.length}</span>
            </header>
            <ul className="mtk-cards">
              {column.map((task) => (
                <li key={task.id} className="mtk-card-slot">
                  {isTarget && dropTarget?.beforeId === task.id ? (
                    <span className="mtk-drop-line" aria-hidden />
                  ) : null}
                  <TaskCard
                    task={task}
                    projects={projects}
                    actions={actions}
                    selected={task.id === selectedId}
                    dragging={task.id === dragId}
                    onSelect={onSelect}
                    onKeyDown={(event) => moveByKeyboard(event, task)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", task.id);
                      setDragId(task.id);
                    }}
                    onDragEnd={() => {
                      setDragId(null);
                      setDropTarget(null);
                    }}
                  />
                </li>
              ))}
              {isTarget && dropTarget?.beforeId === null ? (
                <li className="mtk-card-slot" aria-hidden>
                  <span className="mtk-drop-line" />
                </li>
              ) : null}
            </ul>
            {addingTo === status ? (
              <TaskQuickAdd
                actions={actions}
                status={status}
                placeholder={gt("Task title")}
                onHandOff={onHandOff}
                autoFocus
                onDismiss={() => setAddingTo(null)}
              />
            ) : (
              <button type="button" className="mtk-column-add" onClick={() => setAddingTo(status)}>
                <PlusIcon aria-hidden />
                {gt("Add task")}
              </button>
            )}
          </section>
        );
      })}
    </div>
  );
}

function TaskCard({
  task,
  projects,
  actions,
  selected,
  dragging,
  onSelect,
  onKeyDown,
  onDragStart,
  onDragEnd,
}: {
  readonly task: MattrTask;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly actions: MattrTasksActions;
  readonly selected: boolean;
  readonly dragging: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly onDragStart: (event: DragEvent<HTMLElement>) => void;
  readonly onDragEnd: () => void;
}) {
  const openThread = useOpenTaskThread();
  const note = task.note.trim();
  return (
    <article
      className="mtk-card"
      data-task-id={task.id}
      data-selected={selected ? "" : undefined}
      data-dragging={dragging ? "" : undefined}
      data-done={task.status === "done" ? "" : undefined}
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDoubleClick={() => {
        if (task.linkedThreadRef) openThread(task.linkedThreadRef);
      }}
    >
      <div className="mtk-card-top">
        <TaskCheck task={task} actions={actions} />
        <button
          type="button"
          className="mtk-card-title"
          aria-pressed={selected}
          aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
          onClick={() => onSelect(selected ? null : task.id)}
          onKeyDown={onKeyDown}
        >
          {task.title}
        </button>
      </div>
      {note.length > 0 ? <p className="mtk-card-note">{note}</p> : null}
      <TaskMeta task={task} projects={projects} />
    </article>
  );
}
