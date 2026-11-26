import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { exceededDispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import { projectCommandsForAgent } from "../workspace/TaskFolders.ts";
import { resolveInteractionMode } from "./delegatedTaskModes.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { assertTargetWithinLimits } from "./threadAccess.ts";

const threadId = ThreadId.make("7a1e0c55-0f3b-4f7e-9a61-3c2d8b4e6f10");

describe("goal interaction mode access", () => {
  it.effect("never lets a plan caller start a goal or default child", () =>
    Effect.gen(function* () {
      for (const requested of ["goal", "default"] as const) {
        const error = yield* resolveInteractionMode("plan", requested).pipe(Effect.flip);
        expect(error.code).toBe("interaction_mode_escalation_denied");
      }
      expect(yield* resolveInteractionMode("plan", "inherit")).toBe("plan");
    }),
  );

  it.effect("lets default and goal callers pick any of default, goal and plan", () =>
    Effect.gen(function* () {
      for (const parent of ["default", "goal"] as const) {
        for (const requested of ["default", "goal", "plan"] as const) {
          expect(yield* resolveInteractionMode(parent, requested)).toBe(requested);
        }
        expect(yield* resolveInteractionMode(parent, undefined)).toBe(parent);
      }
    }),
  );

  it.effect("refuses a plan caller's write to a goal thread and allows goal ↔ default", () =>
    Effect.gen(function* () {
      const goalThread = liveThreadShell(threadId, { interactionMode: "goal" });
      const refused = yield* assertTargetWithinLimits(
        { runtimeMode: "full-access", interactionMode: "plan" },
        goalThread,
      ).pipe(Effect.flip);
      expect(refused.code).toBe("interaction_mode_escalation_denied");
      expect(refused.message).toContain("full-access/goal");

      yield* assertTargetWithinLimits(
        { runtimeMode: "full-access", interactionMode: "default" },
        goalThread,
      );
      yield* assertTargetWithinLimits(
        { runtimeMode: "full-access", interactionMode: "goal" },
        liveThreadShell(threadId, { interactionMode: "default" }),
      );
    }),
  );

  it("treats goal like default for dispatch limits and project commands", () => {
    expect(
      exceededDispatchModeLimit(
        { runtimeMode: "full-access", interactionMode: "plan" },
        { runtimeMode: "full-access", interactionMode: "goal" },
      ),
    ).toBe("interaction");
    expect(
      exceededDispatchModeLimit(
        { runtimeMode: "full-access", interactionMode: "default" },
        { runtimeMode: "full-access", interactionMode: "goal" },
      ),
    ).toBeUndefined();
    expect(
      projectCommandsForAgent(
        undefined,
        { runtimeMode: "full-access", interactionMode: "goal" },
        undefined,
      ),
    ).toBe("permitted");
    expect(
      projectCommandsForAgent(
        undefined,
        { runtimeMode: "full-access", interactionMode: "plan" },
        undefined,
      ),
    ).toBe("agent-below-full-access");
  });

  it("keeps a client's narrowed goal or plan request under its approval", () => {
    const ceiling = (narrowedTo: McpInvocationContext.ClientModes) =>
      McpInvocationContext.clientModeCeiling({
        sessionId: "session-1",
        label: "Claude Code",
        access: "full-access",
        narrowedTo,
      });
    expect(ceiling({ runtimeMode: "auto", interactionMode: "goal" })).toEqual({
      runtimeMode: "auto",
      interactionMode: "default",
    });
    expect(ceiling({ runtimeMode: "auto", interactionMode: "plan" }).interactionMode).toBe("plan");
  });
});
