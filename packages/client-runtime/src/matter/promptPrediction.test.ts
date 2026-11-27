import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  matterPromptPredictionToAccept,
  offeredMatterPromptPrediction,
} from "./promptPrediction.ts";

const RUN_1 = RunId.make("run-1");
const RUN_2 = RunId.make("run-2");
const prediction = { runId: RUN_1, text: "Run the tests" };

function run(id: RunId, status: string, startedAt: string | null = "2026-11-27T00:00:00.000Z") {
  return { id, status, startedAt } as never;
}

describe("offeredMatterPromptPrediction", () => {
  it("offers the prediction while its run is the latest finished run", () => {
    const latest = { runId: RUN_1, status: "completed" as const, startedAt: "x" };
    expect(offeredMatterPromptPrediction(prediction, latest, [])).toBe(prediction);
    expect(
      offeredMatterPromptPrediction(prediction, { ...latest, status: "waiting" as const }, []),
    ).toBe(prediction);
  });

  it("hides it while a run is active or once a newer run exists", () => {
    expect(
      offeredMatterPromptPrediction(
        prediction,
        { runId: RUN_1, status: "running", startedAt: "x" },
        [],
      ),
    ).toBeNull();
    expect(
      offeredMatterPromptPrediction(
        prediction,
        { runId: RUN_2, status: "completed", startedAt: "x" },
        [],
      ),
    ).toBeNull();
    expect(offeredMatterPromptPrediction(null, null, [])).toBeNull();
  });

  it("looks past a never-started cancelled run once the runs include it", () => {
    const latest = { runId: RUN_2, status: "cancelled" as const, startedAt: null };
    const runs = [run(RUN_1, "completed"), run(RUN_2, "cancelled", null)];
    expect(offeredMatterPromptPrediction(prediction, latest, runs)).toBe(prediction);
    expect(offeredMatterPromptPrediction(prediction, latest, [run(RUN_1, "completed")])).toBeNull();
  });
});

describe("matterPromptPredictionToAccept", () => {
  it("fills only an empty draft", () => {
    expect(matterPromptPredictionToAccept("Run the tests", "")).toBe("Run the tests");
    expect(matterPromptPredictionToAccept("Run the tests", "h")).toBeNull();
    expect(matterPromptPredictionToAccept(null, "")).toBeNull();
  });
});
