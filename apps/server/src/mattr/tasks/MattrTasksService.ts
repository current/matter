import {
  MATTR_TASK_STATUSES,
  MattrTask,
  type MattrTaskCreateRequest,
  type MattrTaskReorderRequest,
  type MattrTaskStatus,
  type MattrTaskUpdateRequest,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";

export const TASKS_FILENAME = "mattr-tasks.json";

const StoredTasksFile = Schema.Struct({
  version: Schema.Literal(1),
  tasks: Schema.Array(MattrTask),
});
type StoredTasksFile = typeof StoredTasksFile.Type;

const StoredTasksJson = fromJsonStringPretty(StoredTasksFile);
const decodeStoredTasks = Schema.decodeUnknownEffect(StoredTasksJson);
const encodeStoredTasks = Schema.encodeEffect(StoredTasksJson);

const EMPTY_FILE: StoredTasksFile = { version: 1, tasks: [] };

export class MattrTasksError extends Schema.TaggedError<MattrTasksError>()("MattrTasksError", {
  reason: Schema.Literals(["not_found", "read_failed", "write_failed"]),
  detail: Schema.optional(Schema.String),
}) {}

export class MattrTasksService extends Context.Service<
  MattrTasksService,
  {
    readonly list: Effect.Effect<ReadonlyArray<MattrTask>, MattrTasksError>;
    readonly create: (input: MattrTaskCreateRequest) => Effect.Effect<MattrTask, MattrTasksError>;
    readonly update: (
      id: string,
      patch: MattrTaskUpdateRequest,
    ) => Effect.Effect<MattrTask, MattrTasksError>;
    readonly remove: (id: string) => Effect.Effect<void, MattrTasksError>;
    readonly reorder: (
      input: MattrTaskReorderRequest,
    ) => Effect.Effect<ReadonlyArray<MattrTask>, MattrTasksError>;
  }
>()("t3/mattr/tasks/MattrTasksService") {}

const statusRank = (status: MattrTaskStatus) => MATTR_TASK_STATUSES.indexOf(status);

const sortTasks = (tasks: ReadonlyArray<MattrTask>) =>
  tasks.toSorted((a, b) => statusRank(a.status) - statusRank(b.status) || a.order - b.order);

const nextOrder = (tasks: ReadonlyArray<MattrTask>, status: MattrTaskStatus, excludeId?: string) =>
  tasks.reduce(
    (max, task) =>
      task.status === status && task.id !== excludeId ? Math.max(max, task.order + 1) : max,
    0,
  );

const completedAtFor = (previous: MattrTask | null, status: MattrTaskStatus, now: string) => {
  if (status !== "done") return null;
  return previous?.status === "done" ? previous.completedAt : now;
};

const notFound = (id: string) => new MattrTasksError({ reason: "not_found", detail: id });

export const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const random = yield* SecureRandom.SecureRandom;
  const filePath = path.join(serverConfig.stateDir, TASKS_FILENAME);

  const writeLock = yield* Semaphore.make(1);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  // Read lazily so a server that never opens Tasks never touches the file.
  const cache = yield* Ref.make<StoredTasksFile | null>(null);

  const preserveCorruptFile = Effect.fn("MattrTasksService.preserveCorruptFile")(function* (
    cause: unknown,
  ) {
    const stamp = (yield* nowIso).replaceAll(":", "-");
    const backupPath = `${filePath}.corrupt-${stamp}`;
    yield* fileSystem
      .rename(filePath, backupPath)
      .pipe(
        Effect.mapError(
          (error) => new MattrTasksError({ reason: "read_failed", detail: error.message }),
        ),
      );
    yield* Effect.logWarning(`${TASKS_FILENAME} is unreadable; moved it to ${backupPath}.`, cause);
  });

  const load = Effect.fn("MattrTasksService.load")(function* () {
    const cached = yield* Ref.get(cache);
    if (cached) return cached;
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)),
      // Any other read error must fail: falling back to empty would let the next write
      // overwrite tasks we simply couldn't read.
      Effect.mapError(
        (error) => new MattrTasksError({ reason: "read_failed", detail: error.message }),
      ),
    );
    const decoded =
      raw === null
        ? EMPTY_FILE
        : yield* decodeStoredTasks(raw).pipe(
            Effect.catch((error) => preserveCorruptFile(error).pipe(Effect.as(EMPTY_FILE))),
          );
    yield* Ref.set(cache, decoded);
    return decoded;
  });

  const persist = Effect.fn("MattrTasksService.persist")(function* (
    tasks: ReadonlyArray<MattrTask>,
  ) {
    const next: StoredTasksFile = { version: 1, tasks: sortTasks(tasks) };
    const encoded = yield* encodeStoredTasks(next).pipe(
      Effect.mapError(
        (error) => new MattrTasksError({ reason: "write_failed", detail: String(error) }),
      ),
    );
    yield* writeFileStringAtomically({ filePath, contents: `${encoded}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (error) => new MattrTasksError({ reason: "write_failed", detail: error.message }),
      ),
    );
    yield* Ref.set(cache, next);
    return next.tasks;
  });

  const list = Effect.gen(function* () {
    return sortTasks((yield* load()).tasks);
  }).pipe(Effect.withSpan("MattrTasksService.list"));

  const create = Effect.fn("MattrTasksService.create")(function* (input: MattrTaskCreateRequest) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const { tasks } = yield* load();
        const now = yield* nowIso;
        const status = input.status ?? "todo";
        const task: MattrTask = {
          id: yield* random.uuidV4(),
          title: input.title,
          note: input.note ?? "",
          status,
          order: input.order ?? nextOrder(tasks, status),
          projectId: input.projectId ?? null,
          dueDate: input.dueDate ?? null,
          priority: input.priority ?? "none",
          providerInstanceId: input.providerInstanceId ?? null,
          model: input.model ?? null,
          effort: input.effort ?? null,
          workspaceMode: input.workspaceMode ?? "local",
          interactionMode: input.interactionMode ?? "default",
          linkedThreadRef: input.linkedThreadRef ?? null,
          createdAt: now,
          updatedAt: now,
          completedAt: completedAtFor(null, status, now),
        };
        yield* persist([...tasks, task]);
        return task;
      }),
    );
  });

  const update = Effect.fn("MattrTasksService.update")(function* (
    id: string,
    patch: MattrTaskUpdateRequest,
  ) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const { tasks } = yield* load();
        const previous = tasks.find((task) => task.id === id);
        if (!previous) return yield* notFound(id);
        const now = yield* nowIso;
        const status = patch.status ?? previous.status;
        const order =
          patch.order ??
          (status === previous.status ? previous.order : nextOrder(tasks, status, id));
        const next: MattrTask = {
          ...previous,
          ...patch,
          status,
          order,
          updatedAt: now,
          completedAt: completedAtFor(previous, status, now),
        };
        yield* persist(tasks.map((task) => (task.id === id ? next : task)));
        return next;
      }),
    );
  });

  const remove = Effect.fn("MattrTasksService.remove")(function* (id: string) {
    yield* writeLock.withPermit(
      Effect.gen(function* () {
        const { tasks } = yield* load();
        if (!tasks.some((task) => task.id === id)) return yield* notFound(id);
        yield* persist(tasks.filter((task) => task.id !== id));
      }),
    );
  });

  const reorder = Effect.fn("MattrTasksService.reorder")(function* (
    input: MattrTaskReorderRequest,
  ) {
    return yield* writeLock.withPermit(
      Effect.gen(function* () {
        const { tasks } = yield* load();
        const known = new Set(tasks.map((task) => task.id));
        const missing = input.moves.find((move) => !known.has(move.id));
        if (missing) return yield* notFound(missing.id);
        if (input.moves.length === 0) return sortTasks(tasks);
        const now = yield* nowIso;
        const moves = new Map(input.moves.map((move) => [move.id, move]));
        return yield* persist(
          tasks.map((task) => {
            const move = moves.get(task.id);
            if (!move) return task;
            return {
              ...task,
              status: move.status,
              order: move.order,
              updatedAt: now,
              completedAt: completedAtFor(task, move.status, now),
            };
          }),
        );
      }),
    );
  });

  return MattrTasksService.of({ list, create, update, remove, reorder });
});

export const layer = Layer.effect(MattrTasksService, make);
