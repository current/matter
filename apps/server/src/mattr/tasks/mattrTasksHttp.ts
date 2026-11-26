import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  MattrTaskCreateRequest,
  MattrTaskReorderRequest,
  MattrTaskUpdateRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter } from "effect/http";

import {
  authenticate,
  catchAuthErrors,
  INVALID_REQUEST,
  json,
  readJson,
} from "../../bots/mattrHttp.ts";
import * as MattrTasksService from "./MattrTasksService.ts";

const decodeCreate = Schema.decodeUnknownEffect(MattrTaskCreateRequest);
const decodeUpdate = Schema.decodeUnknownEffect(MattrTaskUpdateRequest);
const decodeReorder = Schema.decodeUnknownEffect(MattrTaskReorderRequest);

const tasksErrorResponse = (error: MattrTasksService.MattrTasksError) =>
  Effect.succeed(json({ error: error.reason }, error.reason === "not_found" ? 404 : 500));

const layerTasksRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const tasks = yield* MattrTasksService.MattrTasksService;

    const listRoute = HttpRouter.add(
      "GET",
      "/api/mattr/tasks",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationReadScope);
        return yield* tasks.list.pipe(
          Effect.map((list) => json({ tasks: list })),
          Effect.catchTags({ MattrTasksError: tasksErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const createRoute = HttpRouter.add(
      "POST",
      "/api/mattr/tasks",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeCreate);
        if (!body) return INVALID_REQUEST;
        return yield* tasks.create(body).pipe(
          Effect.map((task) => json({ task })),
          Effect.catchTags({ MattrTasksError: tasksErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const reorderRoute = HttpRouter.add(
      "POST",
      "/api/mattr/tasks/reorder",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const body = yield* readJson(decodeReorder);
        if (!body) return INVALID_REQUEST;
        return yield* tasks.reorder(body).pipe(
          Effect.map((list) => json({ tasks: list })),
          Effect.catchTags({ MattrTasksError: tasksErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const updateRoute = HttpRouter.add(
      "PATCH",
      "/api/mattr/tasks/:id",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const { id } = yield* HttpRouter.params;
        const body = yield* readJson(decodeUpdate);
        if (!id || !body) return INVALID_REQUEST;
        return yield* tasks.update(id, body).pipe(
          Effect.map((task) => json({ task })),
          Effect.catchTags({ MattrTasksError: tasksErrorResponse }),
        );
      }).pipe(catchAuthErrors),
    );

    const deleteRoute = HttpRouter.add(
      "DELETE",
      "/api/mattr/tasks/:id",
      Effect.gen(function* () {
        yield* authenticate(AuthOrchestrationOperateScope);
        const { id } = yield* HttpRouter.params;
        if (!id) return INVALID_REQUEST;
        return yield* tasks
          .remove(id)
          .pipe(
            Effect.as(json({ ok: true })),
            Effect.catchTags({ MattrTasksError: tasksErrorResponse }),
          );
      }).pipe(catchAuthErrors),
    );

    return Layer.mergeAll(listRoute, createRoute, reorderRoute, updateRoute, deleteRoute);
  }),
);

export const layerMattrTasks = layerTasksRoutes.pipe(Layer.provide(MattrTasksService.layer));
