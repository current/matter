import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** mattr Tasks: a personal to-do list and board whose tasks can be handed to an agent thread. */

export const MattrTaskStatus = Schema.Literals(["todo", "in_progress", "in_review", "done"]);
export type MattrTaskStatus = typeof MattrTaskStatus.Type;
export const MATTR_TASK_STATUSES: ReadonlyArray<MattrTaskStatus> = [
  "todo",
  "in_progress",
  "in_review",
  "done",
];

export const MattrTaskPriority = Schema.Literals(["none", "low", "medium", "high"]);
export type MattrTaskPriority = typeof MattrTaskPriority.Type;

export const MattrTaskWorkspaceMode = Schema.Literals(["local", "worktree"]);
export type MattrTaskWorkspaceMode = typeof MattrTaskWorkspaceMode.Type;

export const MattrTaskInteractionMode = Schema.Literals(["default", "plan"]);
export type MattrTaskInteractionMode = typeof MattrTaskInteractionMode.Type;

export const MATTR_TASK_TITLE_MAX_LENGTH = 500;
export const MATTR_TASK_NOTE_MAX_LENGTH = 20_000;

const TaskTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(MATTR_TASK_TITLE_MAX_LENGTH));
const TaskNote = Schema.String.check(Schema.isMaxLength(MATTR_TASK_NOTE_MAX_LENGTH));
const ShortId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
const TaskOrder = Schema.Number.check(Schema.isFinite());
export const MattrTaskDueDate = Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/));

export const MattrTaskThreadRef = Schema.Struct({
  environmentId: ShortId,
  threadId: ShortId,
});
export type MattrTaskThreadRef = typeof MattrTaskThreadRef.Type;

export const MattrTask = Schema.Struct({
  id: ShortId,
  title: TaskTitle,
  note: TaskNote,
  status: MattrTaskStatus,
  order: TaskOrder,
  projectId: Schema.NullOr(ShortId),
  dueDate: Schema.NullOr(MattrTaskDueDate),
  priority: MattrTaskPriority,
  providerInstanceId: Schema.NullOr(ShortId),
  model: Schema.NullOr(ShortId),
  effort: Schema.NullOr(ShortId),
  workspaceMode: MattrTaskWorkspaceMode,
  interactionMode: MattrTaskInteractionMode,
  linkedThreadRef: Schema.NullOr(MattrTaskThreadRef),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  completedAt: Schema.NullOr(Schema.String),
});
export type MattrTask = typeof MattrTask.Type;

/** Fields a client may set; the server owns `id`, timestamps and `completedAt`. */
const EditableFields = {
  note: Schema.optionalKey(TaskNote),
  status: Schema.optionalKey(MattrTaskStatus),
  order: Schema.optionalKey(TaskOrder),
  projectId: Schema.optionalKey(Schema.NullOr(ShortId)),
  dueDate: Schema.optionalKey(Schema.NullOr(MattrTaskDueDate)),
  priority: Schema.optionalKey(MattrTaskPriority),
  providerInstanceId: Schema.optionalKey(Schema.NullOr(ShortId)),
  model: Schema.optionalKey(Schema.NullOr(ShortId)),
  effort: Schema.optionalKey(Schema.NullOr(ShortId)),
  workspaceMode: Schema.optionalKey(MattrTaskWorkspaceMode),
  interactionMode: Schema.optionalKey(MattrTaskInteractionMode),
  linkedThreadRef: Schema.optionalKey(Schema.NullOr(MattrTaskThreadRef)),
};

export const MattrTaskCreateRequest = Schema.Struct({ title: TaskTitle, ...EditableFields });
export type MattrTaskCreateRequest = typeof MattrTaskCreateRequest.Type;

export const MattrTaskUpdateRequest = Schema.Struct({
  title: Schema.optionalKey(TaskTitle),
  ...EditableFields,
});
export type MattrTaskUpdateRequest = typeof MattrTaskUpdateRequest.Type;

export const MattrTaskMove = Schema.Struct({
  id: ShortId,
  status: MattrTaskStatus,
  order: TaskOrder,
});
export type MattrTaskMove = typeof MattrTaskMove.Type;

export const MattrTaskReorderRequest = Schema.Struct({
  moves: Schema.Array(MattrTaskMove).check(Schema.isMaxLength(1000)),
});
export type MattrTaskReorderRequest = typeof MattrTaskReorderRequest.Type;

export const MattrTaskListResponse = Schema.Struct({ tasks: Schema.Array(MattrTask) });
export type MattrTaskListResponse = typeof MattrTaskListResponse.Type;

export const MattrTaskResponse = Schema.Struct({ task: MattrTask });
export type MattrTaskResponse = typeof MattrTaskResponse.Type;
