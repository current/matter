import type {
  MatterTask,
  MatterTaskCreateRequest,
  MatterTaskListResponse,
  MatterTaskMove,
  MatterTaskResponse,
  MatterTaskUpdateRequest,
} from "@t3tools/contracts";
import { useEffect, useSyncExternalStore } from "react";

import { matterApiRequest, type MatterApiConfig, useMatterApiConfig } from "../../addons/matterApi";
import { applyTaskMoves, sortTasks } from "./matterTasks.logic";

export interface MatterTasksState {
  readonly tasks: ReadonlyArray<MatterTask>;
  readonly loaded: boolean;
  readonly error: string | null;
}

const EMPTY: MatterTasksState = { tasks: [], loaded: false, error: null };
let state: MatterTasksState = EMPTY;
let loadedFor: string | null = null;
const listeners = new Set<() => void>();

function setState(next: Partial<MatterTasksState>) {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function reloadMatterTasks(config: MatterApiConfig) {
  try {
    const response = await matterApiRequest<MatterTaskListResponse>(config, "/api/mattr/tasks");
    loadedFor = config.baseUrl;
    setState({ tasks: sortTasks(response.tasks), loaded: true, error: null });
  } catch (error) {
    setState({ loaded: true, error: errorMessage(error) });
  }
}

/** Runs a write optimistically; a failure reloads the server's copy and rethrows. */
async function withRollback<A>(config: MatterApiConfig, run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    await reloadMatterTasks(config);
    throw error;
  }
}

const replaceTask = (task: MatterTask) =>
  setState({
    tasks: sortTasks(
      state.tasks.some((candidate) => candidate.id === task.id)
        ? state.tasks.map((candidate) => (candidate.id === task.id ? task : candidate))
        : [...state.tasks, task],
    ),
  });

export function createMatterTasksActions(config: MatterApiConfig) {
  return {
    create: async (input: MatterTaskCreateRequest) => {
      const { task } = await matterApiRequest<MatterTaskResponse>(config, "/api/mattr/tasks", {
        method: "POST",
        body: input,
      });
      replaceTask(task);
      return task;
    },
    update: (id: string, patch: MatterTaskUpdateRequest) =>
      withRollback(config, async () => {
        setState({
          tasks: sortTasks(
            state.tasks.map((task) =>
              task.id === id ? ({ ...task, ...patch } satisfies MatterTask) : task,
            ),
          ),
        });
        const { task } = await matterApiRequest<MatterTaskResponse>(
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
        await matterApiRequest(config, `/api/mattr/tasks/${encodeURIComponent(id)}`, {
          method: "DELETE",
        });
      }),
    move: (moves: ReadonlyArray<MatterTaskMove>) =>
      withRollback(config, async () => {
        if (moves.length === 0) return;
        setState({
          tasks: sortTasks(applyTaskMoves(state.tasks, moves, new Date().toISOString())),
        });
        const response = await matterApiRequest<MatterTaskListResponse>(
          config,
          "/api/mattr/tasks/reorder",
          { method: "POST", body: { moves } },
        );
        setState({ tasks: sortTasks(response.tasks) });
      }),
  };
}

export type MatterTasksActions = ReturnType<typeof createMatterTasksActions>;

/** Tasks from the primary environment, refreshed when the window comes back into view. */
export function useMatterTasks() {
  const config = useMatterApiConfig();
  const snapshot = useSyncExternalStore(subscribe, () => state);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the server's tasks and re-reads them when another device may have changed them
  useEffect(() => {
    if (!config) return;
    if (loadedFor !== config.baseUrl) setState(EMPTY);
    void reloadMatterTasks(config);
    const onVisible = () => {
      if (document.visibilityState === "visible") void reloadMatterTasks(config);
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

export function resetMatterTasksStoreForTests() {
  state = EMPTY;
  loadedFor = null;
}
