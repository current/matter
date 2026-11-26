import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import "../../index.css";
import "../../../../../antimatter/rareui-chat.css";
import { setLocalStorageItem } from "../../hooks/useLocalStorage";
import {
  MATTR_AI_STATUS_STYLE_STORAGE_KEY,
  MattrAiStatusPhaseCtx,
  MattrAiStatusStyle,
  type MattrAiStatusPhase,
  deriveMattrThinkingCoordination,
  readMattrAiStatusStyle,
} from "../../mattrAiStatus";
import {
  MattrAiStatus,
  MattrThinkingTimelineRow,
  MattrTimelineActivityProvider,
  MattrWorkingTimelineRow,
} from "./MattrAiStatusIndicator";
import {
  TimelineRowActivityCtx,
  TimelineRowCtx,
  type TimelineRow,
  type TimelineRowActivityState,
  type TimelineRowSharedState,
} from "./timelineRowContext";

function aiStatusStyle(style: MattrAiStatusStyle): Disposable {
  setLocalStorageItem(MATTR_AI_STATUS_STYLE_STORAGE_KEY, style, MattrAiStatusStyle);
  return { [Symbol.dispose]: () => localStorage.removeItem(MATTR_AI_STATUS_STYLE_STORAGE_KEY) };
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

function WorkingRow({ phase }: { phase: MattrAiStatusPhase }) {
  return (
    <TimelineRowCtx value={shared}>
      <TimelineRowActivityCtx value={activity}>
        <MattrAiStatusPhaseCtx value={phase}>
          <MattrWorkingTimelineRow
            row={{
              kind: "working",
              id: "working-indicator-row",
              createdAt: "2026-01-01T00:00:00.000Z",
            }}
          />
        </MattrAiStatusPhaseCtx>
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
    expect(readMattrAiStatusStyle()).toBe("default");
    using _style = aiStatusStyle("rareui");
    expect(localStorage.getItem(MATTR_AI_STATUS_STYLE_STORAGE_KEY)).toBe(JSON.stringify("rareui"));
    expect(readMattrAiStatusStyle()).toBe("rareui");
  });

  it("falls back to the default on a value it doesn't know", () => {
    using _consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem(MATTR_AI_STATUS_STYLE_STORAGE_KEY, JSON.stringify("confetti"));
    expect(readMattrAiStatusStyle()).toBe("default");
    localStorage.removeItem(MATTR_AI_STATUS_STYLE_STORAGE_KEY);
  });
});

describe("MattrWorkingTimelineRow", () => {
  it("renders upstream's working timer by default", async () => {
    await using screen = await render(<WorkingRow phase="editing" />, { router: false });
    await expect.poll(() => screen.container.textContent).toMatch(/Working for \d/);
    expect(screen.container.querySelector(".mattr-ais")).toBeNull();
  });

  it("shows RareUI's status for the live phase and follows phase and style changes", async () => {
    using _style = aiStatusStyle("rareui");
    await using screen = await render(<WorkingRow phase="thinking" />, { router: false });
    const status = () => screen.container.querySelector<HTMLElement>(".mattr-ais");
    const label = () =>
      screen.container.querySelector('[data-slot="mattr-ai-status-label"]')?.firstChild
        ?.textContent;
    await expect.poll(() => status()?.dataset.mattrAiStatus).toBe("thinking");
    expect(label()).toBe("Thinking");
    expect(
      screen.container.querySelector('[data-slot="mattr-ai-status-timer"]')?.textContent,
    ).toMatch(/\d/);

    await screen.rerender(<WorkingRow phase="running" />);
    await expect.poll(label).toBe("Running command");
    expect(status()?.dataset.mattrAiStatus).toBe("analyzing");

    // A beat of thinking between tool calls is held back, so the label doesn't flicker.
    await expect.poll(() => screen.container.querySelector(".mattr-ais-text-out")).toBeNull();
    {
      using _timers = fakeTimers();
      await screen.rerender(<WorkingRow phase="thinking" />);
      await screen.rerender(<WorkingRow phase="running" />);
      await act(() => vi.advanceTimersByTime(1000));
      expect(label()).toBe("Running command");
      expect(screen.container.querySelector(".mattr-ais-text-out")).toBeNull();
    }

    await act(() => {
      setLocalStorageItem(MATTR_AI_STATUS_STYLE_STORAGE_KEY, "default", MattrAiStatusStyle);
      window.dispatchEvent(new StorageEvent("storage", { key: MATTR_AI_STATUS_STYLE_STORAGE_KEY }));
    });
    await expect.poll(status).toBeNull();
    expect(screen.container.textContent).toMatch(/Working for/);
  });

  it("asks for input without a timer or any looping animation", async () => {
    using _style = aiStatusStyle("rareui");
    await using screen = await render(<WorkingRow phase="input" />, { router: false });
    await expect
      .poll(() => screen.container.querySelector<HTMLElement>(".mattr-ais")?.dataset.active)
      .toBeUndefined();
    expect(screen.container.textContent).toContain("Needs your input");
    expect(screen.container.querySelector('[data-slot="mattr-ai-status-timer"]')).toBeNull();
    expect(infiniteAnimations(screen.container)).toEqual([]);
  });
});

describe("MattrAiStatus", () => {
  it("loops only while active", async () => {
    await using screen = await render(<MattrAiStatus icon="writing" label="Writing" active />, {
      router: false,
    });
    await expect.poll(() => infiniteAnimations(screen.container).length).toBeGreaterThan(0);
    await screen.rerender(<MattrAiStatus icon="done" label="Worked for 9s" active={false} />);
    await expect.poll(() => infiniteAnimations(screen.container)).toEqual([]);
  });

  it("swaps labels with the leaving copy on top, then drops it", async () => {
    await using screen = await render(<MattrAiStatus icon="thinking" label="Thinking" active />, {
      router: false,
    });
    expect(screen.container.querySelector(".mattr-ais-text-in")).toBeNull();
    await screen.rerender(<MattrAiStatus icon="researching" label="Searching" active />);
    await expect.poll(() => screen.container.querySelector(".mattr-ais-text-in")).not.toBeNull();
    await expect.poll(() => screen.container.querySelector(".mattr-ais-text-out")).toBeNull();
    await expect.poll(() => screen.container.querySelector(".mattr-ais-icon-out")).toBeNull();
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
    const statusRule = reducedRules.find((rule) => rule.startsWith(".mattr-ais, .mattr-ais *"));
    expect(statusRule).toMatch(/animation: [^;]*none !important/);
    expect(statusRule).toContain("transition: none !important");
  });
});

describe("MattrThinkingTimelineRow and working/thinking coordination", () => {
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
      deriveMattrThinkingCoordination(rows, {
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
        <MattrTimelineActivityProvider value={activity} rows={rows}>
          <MattrWorkingTimelineRow row={workingRow} />
          <MattrThinkingTimelineRow row={plainThinkingRow} />
        </MattrTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    const statuses = screen.container.querySelectorAll(".mattr-ais");
    expect(statuses.length).toBe(1);
    expect((statuses[0] as HTMLElement).dataset.mattrAiStatus).toBe("thinking");
    expect(screen.container.querySelectorAll('[data-slot="mattr-ai-status-label"]').length).toBe(1);
  });

  it("renders a single RareUI Thinking row below a steered message while keeping the top row calm", async () => {
    using _style = aiStatusStyle("rareui");
    const rows: ReadonlyArray<TimelineRow> = [workingRow, steerMessageRow, plainThinkingRow];
    expect(
      deriveMattrThinkingCoordination(rows, {
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
        <MattrTimelineActivityProvider value={activity} rows={rows}>
          <div data-testid="top-working">
            <MattrWorkingTimelineRow row={workingRow} />
          </div>
          <div data-testid="bottom-thinking">
            <MattrThinkingTimelineRow row={plainThinkingRow} />
          </div>
        </MattrTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    const top = screen.container.querySelector('[data-testid="top-working"]')!;
    const bottom = screen.container.querySelector('[data-testid="bottom-thinking"]')!;
    await expect.poll(() => top.textContent).toMatch(/Working for \d/);
    expect(top.querySelector(".mattr-ais")).toBeNull();
    const bottomStatus = bottom.querySelector<HTMLElement>(".mattr-ais");
    expect(bottomStatus).not.toBeNull();
    expect(bottomStatus?.dataset.mattrAiStatus).toBe("thinking");
    expect(
      bottom.querySelector('[data-slot="mattr-ai-status-label"]')?.firstChild?.textContent,
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
        <MattrTimelineActivityProvider value={activity} rows={rows}>
          <MattrThinkingTimelineRow row={toggleRow} />
        </MattrTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    const status = screen.container.querySelector<HTMLElement>(".mattr-ais");
    expect(status?.dataset.mattrAiStatus).toBe("analyzing");
    expect(
      screen.container.querySelector('[data-slot="mattr-ai-status-label"]')?.firstChild
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
        <MattrTimelineActivityProvider value={activity} rows={rows}>
          <MattrWorkingTimelineRow row={workingRow} />
          <MattrThinkingTimelineRow row={plainThinkingRow} />
        </MattrTimelineActivityProvider>
      </TimelineRowCtx>,
      { router: false },
    );

    expect(screen.container.querySelector(".mattr-ais")).toBeNull();
    await expect.poll(() => screen.container.textContent).toMatch(/Working for \d/);
    expect(screen.container.textContent).toContain("Thinking");
  });
});
