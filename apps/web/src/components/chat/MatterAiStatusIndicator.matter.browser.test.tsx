import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import "../../index.css";
import "../../../../../matter/rareui-chat.css";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  MATTER_AI_STATUS_STYLE_STORAGE_KEY,
  MatterAiStatusPhaseCtx,
  MatterAiStatusStyle,
  type MatterAiStatusPhase,
  deriveMatterThinkingCoordination,
  readMatterAiStatusStyle,
} from "../../matterAiStatus";
import {
  MatterAiStatus,
  MatterThinkingTimelineRow,
  MatterTimelineActivityProvider,
  MatterWorkingTimelineRow,
} from "./MatterAiStatusIndicator";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
  type TimelineRowActivityState,
  type TimelineRowSharedState,
} from "./timelineRowContext";

function aiStatusStyle(style: MatterAiStatusStyle): Disposable {
  setLocalStorageItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY, style, MatterAiStatusStyle);
  return { [Symbol.dispose]: () => localStorage.removeItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY) };
}

const activity = {
  isWorking: true,
  isCompacting: false,
  isRevertingCheckpoint: false,
  awaitingUser: false,
  isPreparingWorktree: false,
  providerStartingLabel: null,
  providerStarting: null,
  latestRunId: null,
  backgroundWorktreeSetup: null,
  liveAnswerPreview: null,
} satisfies TimelineRowActivityState;

const shared = {
  activeThreadEnvironmentId: "env-test",
  pendingApprovals: new Map(),
  onToggleWorkGroup: vi.fn(),
} as unknown as TimelineRowSharedState;

function WorkingRow({ phase }: { phase: MatterAiStatusPhase }) {
  return (
    <TimelineRowCtx value={shared}>
      <TimelineRowActivityCtx value={activity}>
        <MatterAiStatusPhaseCtx value={phase}>
          <MatterWorkingTimelineRow
            row={{
              kind: "working",
              id: "working-indicator-row",
              createdAt: "2026-01-01T00:00:00.000Z",
            }}
          />
        </MatterAiStatusPhaseCtx>
      </TimelineRowActivityCtx>
    </TimelineRowCtx>
  );
}

const infiniteAnimations = (root: Element) =>
  root
    .getAnimations({ subtree: true })
    .filter((animation) => animation.effect?.getComputedTiming().iterations === Infinity);

describe("AI status style store", () => {
  it("defaults to upstream's indicator and reads the saved style", () => {
    expect(readMatterAiStatusStyle()).toBe("default");
    using _style = aiStatusStyle("rareui");
    expect(localStorage.getItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY)).toBe(JSON.stringify("rareui"));
    expect(readMatterAiStatusStyle()).toBe("rareui");
  });

  it("falls back to the default on a value it doesn't know", () => {
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY, JSON.stringify("confetti"));
    expect(readMatterAiStatusStyle()).toBe("default");
    localStorage.removeItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY);
  });
});

describe("MatterWorkingTimelineRow", () => {
  it("renders upstream's working timer by default", async () => {
    await using screen = await render(<WorkingRow phase="editing" />, { router: false });
    await expect.poll(() => screen.container.textContent).toMatch(/Working for \d/);
    expect(screen.container.querySelector(".matter-ais")).toBeNull();
  });

  it("shows RareUI's status for the live phase and follows phase and style changes", async () => {
    using _style = aiStatusStyle("rareui");
    await using screen = await render(<WorkingRow phase="thinking" />, { router: false });
    const status = () => screen.container.querySelector<HTMLElement>(".matter-ais");
    const label = () =>
      screen.container.querySelector('[data-slot="matter-ai-status-label"]')?.firstChild
        ?.textContent;
    await expect.poll(() => status()?.dataset.matterAiStatus).toBe("thinking");
    expect(label()).toBe("Thinking");
    expect(
      screen.container.querySelector('[data-slot="matter-ai-status-timer"]')?.textContent,
    ).toMatch(/\d/);

    await screen.rerender(<WorkingRow phase="running" />);
    await expect.poll(label).toBe("Running command");
    expect(status()?.dataset.matterAiStatus).toBe("analyzing");

    // A beat of thinking between tool calls is held back, so the label doesn't flicker.
    await expect.poll(() => screen.container.querySelector(".matter-ais-text-out")).toBeNull();
    {
      using _timers = fakeTimers();
      await screen.rerender(<WorkingRow phase="thinking" />);
      await screen.rerender(<WorkingRow phase="running" />);
      await act(() => vi.advanceTimersByTime(1000));
      expect(label()).toBe("Running command");
      expect(screen.container.querySelector(".matter-ais-text-out")).toBeNull();
    }

    await act(() => {
      setLocalStorageItem(MATTER_AI_STATUS_STYLE_STORAGE_KEY, "default", MatterAiStatusStyle);
      window.dispatchEvent(
        new StorageEvent("storage", { key: MATTER_AI_STATUS_STYLE_STORAGE_KEY }),
      );
    });
    await expect.poll(status).toBeNull();
    expect(screen.container.textContent).toMatch(/Working for/);
  });

  it("asks for input without a timer or any looping animation", async () => {
    using _style = aiStatusStyle("rareui");
    await using screen = await render(<WorkingRow phase="input" />, { router: false });
    await expect
      .poll(() => screen.container.querySelector<HTMLElement>(".matter-ais")?.dataset.active)
      .toBeUndefined();
    expect(screen.container.textContent).toContain("Needs your input");
    expect(screen.container.querySelector('[data-slot="matter-ai-status-timer"]')).toBeNull();
    expect(infiniteAnimations(screen.container)).toEqual([]);
  });
});

describe("MatterAiStatus", () => {
  it("loops only while active", async () => {
    await using screen = await render(<MatterAiStatus icon="writing" label="Writing" active />, {
      router: false,
    });
    await expect.poll(() => infiniteAnimations(screen.container).length).toBeGreaterThan(0);
    await screen.rerender(<MatterAiStatus icon="done" label="Worked for 9s" active={false} />);
    await expect.poll(() => infiniteAnimations(screen.container)).toEqual([]);
  });

  it("swaps labels with the leaving copy on top, then drops it", async () => {
    await using screen = await render(<MatterAiStatus icon="thinking" label="Thinking" active />, {
      router: false,
    });
    expect(screen.container.querySelector(".matter-ais-text-in")).toBeNull();
    await screen.rerender(<MatterAiStatus icon="researching" label="Searching" active />);
    await expect.poll(() => screen.container.querySelector(".matter-ais-text-in")).not.toBeNull();
    await expect.poll(() => screen.container.querySelector(".matter-ais-text-out")).toBeNull();
    await expect.poll(() => screen.container.querySelector(".matter-ais-icon-out")).toBeNull();
  });

  it("stops every animation under reduced motion", () => {
    const reducedRules = [...document.styleSheets]
      .flatMap((sheet) => [...sheet.cssRules])
      .filter(
        (rule): rule is CSSMediaRule =>
          rule instanceof CSSMediaRule && rule.conditionText.includes("prefers-reduced-motion"),
      )
      .flatMap((rule) => [...rule.cssRules])
      .map((rule) => rule.cssText);
    const statusRule = reducedRules.find((rule) => rule.startsWith(".matter-ais, .matter-ais *"));
    expect(statusRule).toMatch(/animation: [^;]*none !important/);
    expect(statusRule).toContain("transition: none !important");
  });
});

describe("MatterThinkingTimelineRow and working/thinking coordination", () => {
  const workingRow: Extract<TimelineRow, { kind: "working" }> = {
    kind: "working",
    id: "working-indicator-row",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const plainThinkingRow: Extract<TimelineRow, { kind: "thinking" }> = {
    kind: "thinking",
    id: "live-activity-row",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const steerMessageRow = {
    kind: "message",
    id: "steer-msg-1",
    createdAt: "2026-01-01T00:01:00.000Z",
    message: {
      id: "steer-msg-1",
      role: "user",
      text: "follow up steer",
      streaming: false,
      createdAt: "2026-01-01T00:01:00.000Z",
      updatedAt: "2026-01-01T00:01:00.000Z",
    },
  } as unknown as TimelineRow;

  it("suppresses the redundant plain thinking row right beneath the working row at turn start", async () => {
    using _style = aiStatusStyle("rareui");
    const rows: ReadonlyArray<TimelineRow> = [workingRow, plainThinkingRow];
    expect(
      deriveMatterThinkingCoordination(rows, {
        awaitingUser: false,
        isPreparingWorktree: false,
        isCompacting: false,
        backgroundWorktreeSetup: false,
        providerStarting: false,
        providerStartingLabel: false,
        liveAnswerPreview: false,
      }),
    ).toEqual({ suppressPlainThinkingRow: true, thinkingRowOwnsStatus: false });

    await using screen = await render(
      <TimelineRowCtx value={shared}>
        <MatterTimelineActivityProvider value={activity} rows={rows}>
          <MatterWorkingTimelineRow row={workingRow} />
          <MatterThinkingTimelineRow row={plainThinkingRow} />
        </MatterTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    const statuses = screen.container.querySelectorAll(".matter-ais");
    expect(statuses.length).toBe(1);
    expect((statuses[0] as HTMLElement).dataset.matterAiStatus).toBe("thinking");
    expect(screen.container.querySelectorAll('[data-slot="matter-ai-status-label"]').length).toBe(
      1,
    );
  });

  it("renders a single RareUI Thinking row below a steered message while keeping the top row calm", async () => {
    using _style = aiStatusStyle("rareui");
    const rows: ReadonlyArray<TimelineRow> = [workingRow, steerMessageRow, plainThinkingRow];
    expect(
      deriveMatterThinkingCoordination(rows, {
        awaitingUser: false,
        isPreparingWorktree: false,
        isCompacting: false,
        backgroundWorktreeSetup: false,
        providerStarting: false,
        providerStartingLabel: false,
        liveAnswerPreview: false,
      }),
    ).toEqual({ suppressPlainThinkingRow: false, thinkingRowOwnsStatus: true });

    await using screen = await render(
      <TimelineRowCtx value={shared}>
        <MatterTimelineActivityProvider value={activity} rows={rows}>
          <div data-testid="top-working">
            <MatterWorkingTimelineRow row={workingRow} />
          </div>
          <div data-testid="bottom-thinking">
            <MatterThinkingTimelineRow row={plainThinkingRow} />
          </div>
        </MatterTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    const top = screen.container.querySelector('[data-testid="top-working"]')!;
    const bottom = screen.container.querySelector('[data-testid="bottom-thinking"]')!;
    await expect.poll(() => top.textContent).toMatch(/Working for \d/);
    expect(top.querySelector(".matter-ais")).toBeNull();
    const bottomStatus = bottom.querySelector<HTMLElement>(".matter-ais");
    expect(bottomStatus).not.toBeNull();
    expect(bottomStatus?.dataset.matterAiStatus).toBe("thinking");
    expect(
      bottom.querySelector('[data-slot="matter-ai-status-label"]')?.firstChild?.textContent,
    ).toBe("Thinking");
  });

  it("uses RareUI analyzing status for subagent-wait thinking rows and keeps failed-group disclosure clickable", async () => {
    using _style = aiStatusStyle("rareui");
    const onToggleWorkGroup = vi.fn();
    const toggleRow: Extract<TimelineRow, { kind: "thinking" }> = {
      kind: "thinking",
      id: "live-activity-row",
      createdAt: "2026-01-01T00:00:00.000Z",
      label: "Waiting on 2 subagents",
      groupId: "group-failed",
      expanded: false,
    };
    const rows: ReadonlyArray<TimelineRow> = [workingRow, toggleRow];

    await using screen = await render(
      <TimelineRowCtx value={{ ...shared, onToggleWorkGroup }}>
        <MatterTimelineActivityProvider value={activity} rows={rows}>
          <MatterThinkingTimelineRow row={toggleRow} />
        </MatterTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    const status = screen.container.querySelector<HTMLElement>(".matter-ais");
    expect(status?.dataset.matterAiStatus).toBe("analyzing");
    expect(
      screen.container.querySelector('[data-slot="matter-ai-status-label"]')?.firstChild
        ?.textContent,
    ).toBe("Waiting on 2 subagents");
    const button = screen.container.querySelector("button");
    expect(button).not.toBeNull();
    button?.click();
    expect(onToggleWorkGroup).toHaveBeenCalledWith("group-failed", "live-activity-row");
  });

  it("leaves Default mode completely unchanged with upstream Working and Thinking rows", async () => {
    using _style = aiStatusStyle("default");
    const rows: ReadonlyArray<TimelineRow> = [workingRow, steerMessageRow, plainThinkingRow];

    await using screen = await render(
      <TimelineRowCtx value={shared}>
        <MatterTimelineActivityProvider value={activity} rows={rows}>
          <MatterWorkingTimelineRow row={workingRow} />
          <MatterThinkingTimelineRow row={plainThinkingRow} />
        </MatterTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    expect(screen.container.querySelector(".matter-ais")).toBeNull();
    await expect.poll(() => screen.container.textContent).toMatch(/Working for \d/);
    expect(screen.container.textContent).toContain("Thinking");
  });
});
