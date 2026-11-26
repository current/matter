/* oxlint-disable shadcn/no-unknown-classes -- the `mtk-*` classes come from the fork stylesheet antimatter/tasks.css, which loads outside Tailwind. */
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  MATTR_TASK_NOTE_MAX_LENGTH,
  MATTR_TASK_STATUSES,
  MATTR_TASK_TITLE_MAX_LENGTH,
  type EnvironmentId,
  type MattrTask,
  type MattrTaskPriority,
  type MattrTaskStatus,
  type MattrTaskUpdateRequest,
  type ProjectId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { useGT } from "gt-react";
import {
  ArrowUpRightIcon,
  CalendarIcon,
  ChevronDownIcon,
  CopyIcon,
  EllipsisIcon,
  FolderIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useState, type RefObject } from "react";

import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
} from "../ui/menu";
import { Popover, PopoverPopup } from "../ui/popover";
import { toastManager } from "../ui/toast";
import { localIsoDate, taskPrompt } from "./mattrTasks.logic";
import type { MattrTasksActions } from "./mattrTasksStore";
import {
  modelLabel,
  providerLabel,
  resolveTaskAgentChoice,
  taskModelSelection,
  taskProviderModels,
  usableTaskProviders,
} from "./taskAgent";
import { useOpenTaskThread, useTaskThread, useTaskThreadStateLabel } from "./TaskThreadChip";
import { useStartTaskThread } from "./useStartTaskThread";
import { useTaskStatusLabel } from "./TaskStatusLabel";

export function TaskInspector({
  environmentId,
  task,
  projects,
  actions,
  onClose,
  startRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: MattrTask;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly actions: MattrTasksActions;
  readonly onClose: () => void;
  readonly startRef: RefObject<HTMLButtonElement | null>;
}) {
  const gt = useGT();
  const save = (patch: MattrTaskUpdateRequest) =>
    actions.update(task.id, patch).then(
      () => true,
      () => {
        toastManager.add({ type: "error", title: gt("Could not save the task") });
        return false;
      },
    );
  const update = (patch: MattrTaskUpdateRequest) => {
    void save(patch);
  };

  return (
    <aside
      className="mtk-inspector"
      aria-label={gt("Task details")}
      onKeyDown={(event) => {
        // Menus portal out but still bubble here; their own Escape only closes the menu.
        if (event.key !== "Escape" || event.defaultPrevented) return;
        if (!event.currentTarget.contains(event.target as Node)) return;
        event.preventDefault();
        // Blurring commits a title or note still being typed before the fields unmount.
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && event.currentTarget.contains(focused)) {
          focused.blur();
        }
        onClose();
      }}
    >
      <div className="mtk-inspector-head">
        <TaskTitleField key={task.id} task={task} onCommit={(title) => update({ title })} />
        <button
          type="button"
          className="mtk-icon-button"
          aria-label={gt("Close task")}
          onClick={onClose}
        >
          <XIcon aria-hidden />
        </button>
      </div>
      <TaskNoteField key={`note-${task.id}`} task={task} onCommit={(note) => update({ note })} />
      <div className="mtk-inspector-tools">
        <TaskSchedulePicker task={task} onChange={update} />
        <TaskProjectPicker
          projects={projects}
          projectId={task.projectId}
          onChange={(projectId) => update({ projectId })}
          variant="icon"
        />
        <TaskMoreMenu task={task} actions={actions} onClose={onClose} onChange={update} />
      </div>
      <TaskAgentSection
        environmentId={environmentId}
        task={task}
        projects={projects}
        onChange={update}
        onSave={save}
        startRef={startRef}
      />
    </aside>
  );
}

function TaskTitleField({
  task,
  onCommit,
}: {
  readonly task: MattrTask;
  readonly onCommit: (title: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(task.title);
  const commit = () => {
    const title = draft.trim();
    if (title.length === 0) setDraft(task.title);
    else if (title !== task.title) onCommit(title);
  };
  return (
    <input
      className="mtk-inspector-title"
      aria-label={gt("Task title")}
      value={draft}
      maxLength={MATTR_TASK_TITLE_MAX_LENGTH}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function TaskNoteField({
  task,
  onCommit,
}: {
  readonly task: MattrTask;
  readonly onCommit: (note: string) => void;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState(task.note);
  return (
    <textarea
      className="mtk-inspector-note"
      aria-label={gt("Note")}
      placeholder={gt("Add a note")}
      value={draft}
      maxLength={MATTR_TASK_NOTE_MAX_LENGTH}
      rows={1}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== task.note) onCommit(draft);
      }}
    />
  );
}

export function usePriorityLabel() {
  const gt = useGT();
  return (priority: MattrTaskPriority) => {
    switch (priority) {
      case "high":
        return gt("High", { $context: "task priority" });
      case "medium":
        return gt("Medium", { $context: "task priority" });
      case "low":
        return gt("Low", { $context: "task priority" });
      default:
        return gt("No priority");
    }
  };
}

function TaskSchedulePicker({
  task,
  onChange,
}: {
  readonly task: MattrTask;
  readonly onChange: (patch: MattrTaskUpdateRequest) => void;
}) {
  const gt = useGT();
  const priorityLabel = usePriorityLabel();
  const [today] = useState(() => new Date());
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
  const nextWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);
  const active = task.dueDate !== null || task.priority !== "none";
  return (
    <Popover>
      <PopoverPrimitive.Trigger
        className="mtk-icon-button"
        data-active={active ? "" : undefined}
        aria-label={gt("Due date and priority")}
      >
        <CalendarIcon aria-hidden />
      </PopoverPrimitive.Trigger>
      <PopoverPopup align="start" padding="compact">
        <div className="mtk-popover-body">
          <span className="mtk-popover-label">{gt("Due date")}</span>
          <div className="mtk-quick-dates">
            <button type="button" onClick={() => onChange({ dueDate: localIsoDate(today) })}>
              {gt("Today")}
            </button>
            <button type="button" onClick={() => onChange({ dueDate: localIsoDate(tomorrow) })}>
              {gt("Tomorrow")}
            </button>
            <button type="button" onClick={() => onChange({ dueDate: localIsoDate(nextWeek) })}>
              {gt("Next week")}
            </button>
          </div>
          <div className="mtk-date-row">
            <input
              type="date"
              className="mtk-date-input"
              aria-label={gt("Due date")}
              value={task.dueDate ?? ""}
              onChange={(event) =>
                onChange({ dueDate: event.target.value === "" ? null : event.target.value })
              }
            />
            {task.dueDate !== null ? (
              <button
                type="button"
                className="mtk-link"
                onClick={() => onChange({ dueDate: null })}
              >
                {gt("Clear")}
              </button>
            ) : null}
          </div>
          <span className="mtk-popover-label">{gt("Priority")}</span>
          <div className="mtk-segmented" role="radiogroup" aria-label={gt("Priority")}>
            {(["none", "low", "medium", "high"] as const).map((priority) => (
              <button
                key={priority}
                type="button"
                role="radio"
                aria-checked={task.priority === priority}
                onClick={() => onChange({ priority })}
              >
                {priority === "none"
                  ? gt("None", { $context: "no task priority" })
                  : priorityLabel(priority)}
              </button>
            ))}
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function TaskProjectPicker({
  projects,
  projectId,
  onChange,
  variant,
}: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly projectId: string | null;
  readonly onChange: (projectId: string | null) => void;
  readonly variant: "icon" | "pill";
}) {
  const gt = useGT();
  const project = projects.find((candidate) => candidate.id === projectId) ?? null;
  return (
    <Menu>
      <MenuPrimitive.Trigger
        className={variant === "icon" ? "mtk-icon-button" : "mtk-picker"}
        data-active={project ? "" : undefined}
        aria-label={gt("Project")}
      >
        <FolderIcon aria-hidden />
        {variant === "pill" ? (
          <>
            <span className="mtk-picker-text">{project?.title ?? gt("Project")}</span>
            <ChevronDownIcon aria-hidden className="mtk-chevron" />
          </>
        ) : null}
      </MenuPrimitive.Trigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={projectId ?? ""}
          onValueChange={(value: string) => onChange(value === "" ? null : value)}
        >
          <MenuRadioItem closeOnClick value="">
            {gt("No project")}
          </MenuRadioItem>
          {projects.length > 0 ? <MenuSeparator /> : null}
          {projects.map((candidate) => (
            <MenuRadioItem closeOnClick key={candidate.id} value={candidate.id}>
              <span className="truncate">{candidate.title}</span>
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

function TaskMoreMenu({
  task,
  actions,
  onClose,
  onChange,
}: {
  readonly task: MattrTask;
  readonly actions: MattrTasksActions;
  readonly onClose: () => void;
  readonly onChange: (patch: MattrTaskUpdateRequest) => void;
}) {
  const gt = useGT();
  const statusLabel = useTaskStatusLabel();
  return (
    <Menu>
      <MenuPrimitive.Trigger className="mtk-icon-button" aria-label={gt("More task actions")}>
        <EllipsisIcon aria-hidden />
      </MenuPrimitive.Trigger>
      <MenuPopup align="start">
        <MenuGroup>
          <MenuGroupLabel>{gt("Move to")}</MenuGroupLabel>
          <MenuRadioGroup
            value={task.status}
            onValueChange={(value: MattrTaskStatus) => onChange({ status: value })}
          >
            {MATTR_TASK_STATUSES.map((status) => (
              <MenuRadioItem closeOnClick key={status} value={status}>
                {statusLabel(status)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            void actions
              .create({
                title: task.title,
                note: task.note,
                status: task.status === "done" ? "todo" : task.status,
                projectId: task.projectId,
                dueDate: task.dueDate,
                priority: task.priority,
                providerInstanceId: task.providerInstanceId,
                model: task.model,
                effort: task.effort,
                workspaceMode: task.workspaceMode,
                interactionMode: task.interactionMode,
              })
              .catch(() =>
                toastManager.add({ type: "error", title: gt("Could not duplicate the task") }),
              )
          }
        >
          <CopyIcon aria-hidden />
          {gt("Duplicate")}
        </MenuItem>
        <MenuItem
          variant="destructive"
          onClick={() => {
            onClose();
            void actions
              .remove(task.id)
              .catch(() =>
                toastManager.add({ type: "error", title: gt("Could not delete the task") }),
              );
          }}
        >
          <Trash2Icon aria-hidden />
          {gt("Delete")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}

function TaskAgentSection({
  environmentId,
  task,
  projects,
  onChange,
  onSave,
  startRef,
}: {
  readonly environmentId: EnvironmentId;
  readonly task: MattrTask;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly onChange: (patch: MattrTaskUpdateRequest) => void;
  readonly onSave: (patch: MattrTaskUpdateRequest) => Promise<boolean>;
  readonly startRef: RefObject<HTMLButtonElement | null>;
}) {
  const gt = useGT();
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const settings = useEnvironmentSettings(environmentId);
  const project = projects.find((candidate) => candidate.id === task.projectId) ?? null;
  const projectSettings = resolveProjectSettings(
    settings,
    (project?.id ?? null) as ProjectId | null,
  ).settings;
  const choice = resolveTaskAgentChoice({
    providers,
    providerInstanceId: task.providerInstanceId,
    model: task.model,
    effort: task.effort,
    defaultSelection: projectSettings.defaultModelSelection,
  });
  const [moreOpen, setMoreOpen] = useState(
    task.workspaceMode !== "local" || task.interactionMode !== "default",
  );
  const [starting, setStarting] = useState(false);
  const startTaskThread = useStartTaskThread();
  const linked = useTaskThread(task.linkedThreadRef);
  const threadStateLabel = useTaskThreadStateLabel();
  const openThread = useOpenTaskThread();
  const hasLinkedThread = task.linkedThreadRef !== null && linked.thread !== null;

  const start = async () => {
    if (!project) {
      toastManager.add({ type: "error", title: gt("Pick a project for the agent to work in") });
      return;
    }
    if (!choice) {
      toastManager.add({
        type: "error",
        title: gt("No agent is ready. Sign in to a provider first."),
      });
      return;
    }
    setStarting(true);
    const outcome = await startTaskThread({
      project,
      title: task.title,
      prompt: taskPrompt(task),
      modelSelection: taskModelSelection(choice),
      runtimeMode: projectSettings.defaultRuntimeMode,
      interactionMode: task.interactionMode,
      workspaceMode: task.workspaceMode,
    }).then(
      (ref) => ({ ref, error: null }),
      (error: unknown) => ({ ref: null, error }),
    );
    setStarting(false);
    if (outcome.ref === null) {
      toastManager.add({
        type: "error",
        title: gt("Could not start the agent"),
        description: outcome.error instanceof Error ? outcome.error.message : undefined,
      });
      return;
    }
    const linkedThreadRef = {
      environmentId: outcome.ref.environmentId,
      threadId: outcome.ref.threadId,
    };
    const linkedSaved = await onSave({
      linkedThreadRef,
      status: task.status === "todo" || task.status === "done" ? "in_progress" : task.status,
      providerInstanceId: choice.provider.instanceId,
      model: choice.model.slug,
      effort: choice.effort,
    });
    if (!linkedSaved) return;
    toastManager.add({
      type: "success",
      title: gt("Agent started"),
      actionProps: { children: gt("Open thread"), onClick: () => openThread(linkedThreadRef) },
    });
  };

  return (
    <section className="mtk-agent" aria-label={gt("Hand it to an agent")}>
      <h3 className="mtk-agent-title">{gt("Hand it to an agent")}</h3>
      {hasLinkedThread && task.linkedThreadRef ? (
        <div className="mtk-agent-linked" data-state={linked.state}>
          <span className="mtk-dot" aria-hidden />
          <span className="mtk-agent-linked-state">{threadStateLabel(linked.state)}</span>
          <span className="mtk-agent-linked-title">{linked.thread?.title}</span>
          <button
            type="button"
            className="mtk-link"
            onClick={() => task.linkedThreadRef && openThread(task.linkedThreadRef)}
          >
            {gt("Open thread")}
            <ArrowUpRightIcon aria-hidden />
          </button>
        </div>
      ) : null}
      <div className="mtk-agent-pickers">
        <TaskModelPicker
          providers={usableTaskProviders(providers)}
          choice={choice}
          onChange={(providerInstanceId, model) =>
            onChange({ providerInstanceId, model, effort: null })
          }
        />
        {choice && choice.effortChoices.length > 0 ? (
          <Menu>
            <MenuPrimitive.Trigger className="mtk-picker" aria-label={gt("Effort")}>
              <span className="mtk-picker-text">
                {choice.effortChoices.find((entry) => entry.id === choice.effort)?.label ??
                  gt("Effort")}
              </span>
              <ChevronDownIcon aria-hidden className="mtk-chevron" />
            </MenuPrimitive.Trigger>
            <MenuPopup align="start">
              <MenuRadioGroup
                value={choice.effort ?? ""}
                onValueChange={(effort: string) => onChange({ effort })}
              >
                {choice.effortChoices.map((entry) => (
                  <MenuRadioItem closeOnClick key={entry.id} value={entry.id}>
                    {entry.label}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </Menu>
        ) : null}
        <TaskProjectPicker
          projects={projects}
          projectId={task.projectId}
          onChange={(projectId) => onChange({ projectId })}
          variant="pill"
        />
      </div>
      {moreOpen ? (
        <div className="mtk-agent-more">
          <div className="mtk-segmented" role="radiogroup" aria-label={gt("Workspace")}>
            <button
              type="button"
              role="radio"
              aria-checked={task.workspaceMode === "local"}
              onClick={() => onChange({ workspaceMode: "local" })}
            >
              {gt("Local")}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={task.workspaceMode === "worktree"}
              onClick={() => onChange({ workspaceMode: "worktree" })}
            >
              {gt("Worktree")}
            </button>
          </div>
          <div className="mtk-segmented" role="radiogroup" aria-label={gt("Mode")}>
            <button
              type="button"
              role="radio"
              aria-checked={task.interactionMode === "default"}
              onClick={() => onChange({ interactionMode: "default" })}
            >
              {gt("Default", { $context: "agent interaction mode that just does the work" })}
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={task.interactionMode === "plan"}
              onClick={() => onChange({ interactionMode: "plan" })}
            >
              {gt("Plan", { $context: "agent interaction mode that plans first" })}
            </button>
          </div>
        </div>
      ) : null}
      <div className="mtk-agent-foot">
        <button
          type="button"
          className="mtk-link mtk-more-toggle"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen((open) => !open)}
        >
          {moreOpen ? gt("Fewer options") : gt("More options")}
        </button>
        <button
          ref={startRef}
          type="button"
          className="mtk-start"
          disabled={starting}
          aria-busy={starting}
          onClick={() => void start()}
        >
          {hasLinkedThread ? gt("Start new run") : gt("Start")}
        </button>
      </div>
    </section>
  );
}

function TaskModelPicker({
  providers,
  choice,
  onChange,
}: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly choice: ReturnType<typeof resolveTaskAgentChoice>;
  readonly onChange: (providerInstanceId: string, model: string) => void;
}) {
  const gt = useGT();
  if (!choice) {
    return <span className="mtk-picker mtk-picker-empty">{gt("No agent ready")}</span>;
  }
  return (
    <Menu>
      <MenuPrimitive.Trigger
        className="mtk-picker mtk-picker-model"
        aria-label={gt("Agent and model")}
      >
        <ProviderInstanceIcon
          driverKind={choice.provider.driver}
          displayName={providerLabel(choice.provider)}
          accentColor={choice.provider.accentColor}
          iconClassName="size-3.5"
        />
        <span className="mtk-picker-text">{modelLabel(choice.model)}</span>
        <ChevronDownIcon aria-hidden className="mtk-chevron" />
      </MenuPrimitive.Trigger>
      <MenuPopup align="start">
        <MenuRadioGroup
          value={`${choice.provider.instanceId}\u0000${choice.model.slug}`}
          onValueChange={(value: string) => {
            const [instanceId, model] = value.split("\u0000");
            if (instanceId && model) onChange(instanceId, model);
          }}
        >
          {providers.map((provider, index) => (
            <MenuGroup key={provider.instanceId}>
              {index > 0 ? <MenuSeparator /> : null}
              <MenuGroupLabel>{providerLabel(provider)}</MenuGroupLabel>
              {taskProviderModels(provider).map((model) => (
                <MenuRadioItem
                  closeOnClick
                  key={model.slug}
                  value={`${provider.instanceId}\u0000${model.slug}`}
                >
                  <span className="truncate">{model.name}</span>
                </MenuRadioItem>
              ))}
            </MenuGroup>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
