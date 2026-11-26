import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Matter Tasks: a personal to-do list and board whose tasks can be handed to an agent thread. */

export const MatterTaskStatus = Schema.Literals(["todo", "in_progress", "in_review", "done"]);
export type MatterTaskStatus = typeof MatterTaskStatus.Type;
export const MATTER_TASK_STATUSES: ReadonlyArray<MatterTaskStatus> = [
  "todo",
  "in_progress",
  "in_review",
  "done",
];

export const MatterTaskPriority = Schema.Literals(["none", "low", "medium", "high"]);
export type MatterTaskPriority = typeof MatterTaskPriority.Type;

export const MatterTaskWorkspaceMode = Schema.Literals(["local", "worktree"]);
export type MatterTaskWorkspaceMode = typeof MatterTaskWorkspaceMode.Type;

export const MatterTaskInteractionMode = Schema.Literals(["default", "plan"]);
export type MatterTaskInteractionMode = typeof MatterTaskInteractionMode.Type;

export const MATTER_TASK_TITLE_MAX_LENGTH = 500;
export const MATTER_TASK_NOTE_MAX_LENGTH = 20_000;

const TaskTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(MATTER_TASK_TITLE_MAX_LENGTH));
const TaskNote = Schema.String.check(Schema.isMaxLength(MATTER_TASK_NOTE_MAX_LENGTH));
const ShortId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const TaskOrder = Schema.Number.check(Schema.isFinite());
export const MatterTaskDueDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

export const MatterTaskThreadRef = Schema.Struct({
  environmentId: ShortId,
  threadId: ShortId,
});
export type MatterTaskThreadRef = typeof MatterTaskThreadRef.Type;

export const MatterTask = Schema.Struct({
  id: ShortId,
  title: TaskTitle,
  note: TaskNote,
  status: MatterTaskStatus,
  order: TaskOrder,
  projectId: Schema.NullOr(ShortId),
  dueDate: Schema.NullOr(MatterTaskDueDate),
  priority: MatterTaskPriority,
  providerInstanceId: Schema.NullOr(ShortId),
  model: Schema.NullOr(ShortId),
  effort: Schema.NullOr(ShortId),
  workspaceMode: MatterTaskWorkspaceMode,
  interactionMode: MatterTaskInteractionMode,
  linkedThreadRef: Schema.NullOr(MatterTaskThreadRef),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type MatterTask = typeof MatterTask.Type;

/** Fields a client may set; the server owns `id`, timestamps and `completedAt`. */
const EditableFields = {
  note: Schema.optionalKey(TaskNote),
  status: Schema.optionalKey(MatterTaskStatus),
  order: Schema.optionalKey(TaskOrder),
  projectId: Schema.optionalKey(Schema.NullOr(ShortId)),
  dueDate: Schema.optionalKey(Schema.NullOr(MatterTaskDueDate)),
  priority: Schema.optionalKey(MatterTaskPriority),
  providerInstanceId: Schema.optionalKey(Schema.NullOr(ShortId)),
  model: Schema.optionalKey(Schema.NullOr(ShortId)),
  effort: Schema.optionalKey(Schema.NullOr(ShortId)),
  workspaceMode: Schema.optionalKey(MatterTaskWorkspaceMode),
  interactionMode: Schema.optionalKey(MatterTaskInteractionMode),
  linkedThreadRef: Schema.optionalKey(Schema.NullOr(MatterTaskThreadRef)),
};

export const MatterTaskCreateRequest = Schema.Struct({ title: TaskTitle, ...EditableFields });
export type MatterTaskCreateRequest = typeof MatterTaskCreateRequest.Type;

export const MatterTaskUpdateRequest = Schema.Struct({
  title: Schema.optionalKey(TaskTitle),
  ...EditableFields,
});
export type MatterTaskUpdateRequest = typeof MatterTaskUpdateRequest.Type;

export const MatterTaskMove = Schema.Struct({
  id: ShortId,
  status: MatterTaskStatus,
  order: TaskOrder,
});
export type MatterTaskMove = typeof MatterTaskMove.Type;

export const MatterTaskReorderRequest = Schema.Struct({
  moves: Schema.Array(MatterTaskMove).check(Schema.isMaxLength(1000)),
});
export type MatterTaskReorderRequest = typeof MatterTaskReorderRequest.Type;

export const MatterTaskListResponse = Schema.Struct({ tasks: Schema.Array(MatterTask) });
export type MatterTaskListResponse = typeof MatterTaskListResponse.Type;

export const MatterTaskResponse = Schema.Struct({ task: MatterTask });
export type MatterTaskResponse = typeof MatterTaskResponse.Type;
