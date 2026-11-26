import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import * as MatterTasksService from "./MatterTasksService.ts";

const configLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-matter-tasks-" });
const layer = MatterTasksService.layer.pipe(
  Layer.provideMerge(configLayer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const tasksFilePath = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.stateDir, MatterTasksService.TASKS_FILENAME);
});

/** A fresh service over the same state dir, as after a server restart. */
const restarted = MatterTasksService.make;

const errorReason = <A>(effect: Effect.Effect<A, MatterTasksService.MatterTasksError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

describe("MatterTasksService", () => {
  it.effect("starts empty without touching disk", () =>
    Effect.gen(function* () {
      const service = yield* MatterTasksService.MatterTasksService;
      const fileSystem = yield* FileSystem.FileSystem;
      assert.deepStrictEqual(yield* service.list, []);
      assert.isFalse(yield* fileSystem.exists(yield* tasksFilePath));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fills defaults and appends each new task to the end of its column", () =>
    Effect.gen(function* () {
      const service = yield* MatterTasksService.MatterTasksService;
      const first = yield* service.create({ title: "First" });
      assert.deepInclude(first, {
        title: "First",
        note: "",
        status: "todo",
        priority: "none",
        order: 0,
        projectId: null,
        dueDate: null,
        providerInstanceId: null,
        model: null,
        effort: null,
        workspaceMode: "local",
        interactionMode: "default",
        linkedThreadRef: null,
        completedAt: null,
      });
      assert.strictEqual(first.createdAt, first.updatedAt);
      const second = yield* service.create({ title: "Second" });
      const review = yield* service.create({ title: "Review", status: "in_review" });
      const done = yield* service.create({ title: "Done", status: "done" });
      assert.strictEqual(second.order, 1);
      assert.strictEqual(review.order, 0);
      assert.isString(done.completedAt);
      assert.deepStrictEqual(
        (yield* service.list).map((task) => task.title),
        ["First", "Second", "Review", "Done"],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("writes atomically and privately, and reads back after a restart", () =>
    Effect.gen(function* () {
      const service = yield* MatterTasksService.MatterTasksService;
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const task = yield* service.create({ title: "Keep me", priority: "high" });
      const stat = yield* fileSystem.stat(yield* tasksFilePath);
      assert.strictEqual(stat.mode & 0o777, 0o600);
      const leftovers = (yield* fileSystem.readDirectory(config.stateDir)).filter(
        (name) => name.endsWith(".tmp") || name.startsWith("t3-write-"),
      );
      assert.deepStrictEqual(leftovers, []);
      assert.deepStrictEqual(yield* (yield* restarted).list, [task]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("merges updates and bumps updatedAt", () =>
    Effect.gen(function* () {
      const service = yield* MatterTasksService.MatterTasksService;
      const task = yield* service.create({ title: "Draft", note: "keep" });
      const updated = yield* service.update(task.id, {
        title: "Final",
        dueDate: "2026-12-01",
      });
      assert.deepInclude(updated, {
        id: task.id,
        title: "Final",
        note: "keep",
        dueDate: "2026-12-01",
        createdAt: task.createdAt,
      });
      assert.isTrue(updated.updatedAt >= task.updatedAt);
    }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "stamps completedAt on done, clears it when reopened, and appends to the new column",
    () =>
      Effect.gen(function* () {
        const service = yield* MatterTasksService.MatterTasksService;
        yield* service.create({ title: "Already done", status: "done" });
        const task = yield* service.create({ title: "Work" });
        const done = yield* service.update(task.id, { status: "done" });
        assert.isString(done.completedAt);
        assert.strictEqual(done.order, 1);
        const stillDone = yield* service.update(task.id, { note: "edited" });
        assert.strictEqual(stillDone.completedAt, done.completedAt);
        const reopened = yield* service.update(task.id, { status: "in_progress" });
        assert.isNull(reopened.completedAt);
        assert.strictEqual(reopened.order, 0);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("applies a reorder across columns in one write", () =>
    Effect.gen(function* () {
      const service = yield* MatterTasksService.MatterTasksService;
      const a = yield* service.create({ title: "A" });
      const b = yield* service.create({ title: "B" });
      const c = yield* service.create({ title: "C", status: "done" });
      const tasks = yield* service.reorder({
        moves: [
          { id: a.id, status: "done", order: 0 },
          { id: c.id, status: "todo", order: 5 },
          { id: b.id, status: "todo", order: 1 },
        ],
      });
      assert.deepStrictEqual(
        tasks.map(({ title, status, order }) => ({ title, status, order })),
        [
          { title: "B", status: "todo", order: 1 },
          { title: "C", status: "todo", order: 5 },
          { title: "A", status: "done", order: 0 },
        ],
      );
      assert.isString(tasks.find((task) => task.id === a.id)?.completedAt);
      assert.isNull(tasks.find((task) => task.id === c.id)?.completedAt);
      assert.deepStrictEqual(yield* (yield* restarted).list, tasks);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("reports unknown ids as not_found and leaves the file unchanged", () =>
    Effect.gen(function* () {
      const service = yield* MatterTasksService.MatterTasksService;
      const fileSystem = yield* FileSystem.FileSystem;
      const task = yield* service.create({ title: "Only" });
      const before = yield* fileSystem.readFileString(yield* tasksFilePath);
      assert.strictEqual(
        yield* errorReason(service.update("missing", { title: "x" })),
        "not_found",
      );
      assert.strictEqual(yield* errorReason(service.remove("missing")), "not_found");
      assert.strictEqual(
        yield* errorReason(
          service.reorder({
            moves: [
              { id: task.id, status: "done", order: 0 },
              { id: "missing", status: "todo", order: 0 },
            ],
          }),
        ),
        "not_found",
      );
      assert.strictEqual(yield* fileSystem.readFileString(yield* tasksFilePath), before);
      assert.deepStrictEqual(yield* service.list, [task]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("removes a task", () =>
    Effect.gen(function* () {
      const service = yield* MatterTasksService.MatterTasksService;
      const task = yield* service.create({ title: "Gone" });
      yield* service.remove(task.id);
      assert.deepStrictEqual(yield* (yield* restarted).list, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("moves a corrupt file aside before starting empty", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(yield* tasksFilePath, "{not json");
      const service = yield* restarted;
      assert.deepStrictEqual(yield* service.list, []);
      const backups = (yield* fileSystem.readDirectory(config.stateDir)).filter((name) =>
        name.startsWith(`${MatterTasksService.TASKS_FILENAME}.corrupt-`),
      );
      assert.strictEqual(backups.length, 1);
      const path = yield* Path.Path;
      assert.strictEqual(
        yield* fileSystem.readFileString(path.join(config.stateDir, backups[0]!)),
        "{not json",
      );
      const task = yield* service.create({ title: "Fresh" });
      assert.deepStrictEqual(yield* (yield* restarted).list, [task]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("fails instead of overwriting a file it cannot read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const filePath = yield* tasksFilePath;
      yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
      // A directory in the file's place makes the read fail with something other than NotFound.
      yield* fileSystem.makeDirectory(filePath);
      const service = yield* restarted;
      assert.strictEqual(yield* errorReason(service.list), "read_failed");
      assert.strictEqual(yield* errorReason(service.create({ title: "Lost" })), "read_failed");
      assert.isTrue((yield* fileSystem.stat(filePath)).type === "Directory");
    }).pipe(Effect.provide(layer)),
  );
});
