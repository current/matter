import type {
  MattrTask,
  MattrTaskCreateRequest,
  MattrTaskListResponse,
  MattrTaskMove,
  MattrTaskResponse,
  MattrTaskUpdateRequest,
} from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { mattrApiRequest, type MattrApiConfig, useMattrApiConfig } from "../../addons/mattrApi";
import { applyTaskMoves, sortTasks } from "./mattrTasks.logic";

export interface MattrTasksState {
  readonly tasks: ReadonlyArray<MattrTask>;
  readonly loaded: boolean;
  readonly error: string | null;
}

const EMPTY: MattrTasksState = { tasks: [], loaded: false, error: null };
let state: MattrTasksState = EMPTY;
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<MattrTasksState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function reloadMattrTasks(config: MattrApiConfig) {
  try {
    const response = await mattrApiRequest<MattrTaskListResponse>(config, "/api/mattr/tasks");
    loadedFor = config.baseUrl;
    setState({ tasks: sortTasks(response.tasks), loaded: true, error: null });
  } catch (error) {
    setState({ loaded: true, error: errorMessage(error) });
  }
}

/** Runs a write optimistically; a failure reloads the server's copy and rethrows. */
async function withRollback<A>(config: MattrApiConfig, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    await reloadMattrTasks(config);
    throw error;
  }
}

const replaceTask = (task: MattrTask) =>
  setState({
    tasks: sortTasks(
      state.tasks.some((candidate) => candidate.id === task.id)
        ? state.tasks.map((candidate) => (candidate.id === task.id ? task : candidate))
        : [...state.tasks, task],
    ),
  });

export function createMattrTasksActions(config: MattrApiConfig) {
  return {
    create: async (input: MattrTaskCreateRequest) => {
      const { task } = await mattrApiRequest<MattrTaskResponse>(config, "/api/mattr/tasks", {
        method: "POST",
        body: input,
      });
      replaceTask(task);
      return task;
    },
    update: (id: string, patch: MattrTaskUpdateRequest) =>
      withRollback(config, async () => {
        setState({
          tasks: sortTasks(
            state.tasks.map((task) =>
              task.id === id ? ({ ...task, ...patch } satisfies MattrTask) : task,
            ),
          ),
        });
        const { task } = await mattrApiRequest<MattrTaskResponse>(
          config,
          `/api/mattr/tasks/${encodeURIComponent(id)}`,
          { method: "PATCH", body: patch },
        );
        replaceTask(task);
        return task;
      }),
    remove: (id: string) =>
      withRollback(config, async () => {
        setState({ tasks: state.tasks.filter((task) => task.id !== id) });
        await mattrApiRequest(config, `/api/mattr/tasks/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      }),
    move: (moves: ReadonlyArray<MattrTaskMove>) =>
      withRollback(config, async () => {
        if (moves.length === 0) return;
        setState({
          tasks: sortTasks(applyTaskMoves(state.tasks, moves, new Date().toISOString())),
        });
        const response = await mattrApiRequest<MattrTaskListResponse>(
          config,
          "/api/mattr/tasks/reorder",
          { method: "POST", body: { moves } },
        );
        setState({ tasks: sortTasks(response.tasks) });
      }),
  };
}

export type MattrTasksActions = ReturnType<typeof createMattrTasksActions>;

/** Tasks from the primary environment, refreshed when the window comes back into view. */
export function useMattrTasks() {
  const config = useMattrApiConfig();
  const snapshot = useSyncExternalStore(subscribe, () => state);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the server's tasks and re-reads them when another device may have changed them
  useEffect(() => {
    if (!config) return;
    if (loadedFor !== config.baseUrl) setState(EMPTY);
    void reloadMattrTasks(config);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reloadMattrTasks(config);
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
  }, [config]);

  return { config, ...snapshot };
}

export function resetMattrTasksStoreForTests() {
  state = EMPTY;
  loadedFor = null;
}
