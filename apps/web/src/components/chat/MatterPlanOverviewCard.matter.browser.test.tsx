import "~/index.css";
import "../../../../../matter/questions-plan.css";

import { EnvironmentId, PlanId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../../test/render";
import {
  MATTER_PLAN_AUTO_APPROVE_STORAGE_KEY,
  writeMatterPlanAutoApprove,
} from "../../matterPlanAutoApprove";
import { toastManager } from "../ui/toast";
import {
  MatterPlanOverviewCard,
  resetDisarmedMatterPlanAutoApproveForTests,
  type MatterPlanOverviewCardProps,
} from "./MatterPlanOverviewCard.matter";

const environmentId = EnvironmentId.make("env");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };

const PLAN = [
  "# Session auth migration",
  "",
  "Ship cookie-based sessions with middleware and tests.",
  "Includes a safe rollout path for production.",
  "",
  "## To-dos",
  "- [ ] Add migration for sessions table",
  "- [ ] Wire auth middleware",
  "- [ ] Update login flow + tests",
  "- [ ] Add account settings page",
  "- [ ] Tighten CSRF + rate limits",
  "- [x] Write rollout notes",
].join("\n");

function card(overrides: Partial<MatterPlanOverviewCardProps> = {}) {
  return (
    <MatterPlanOverviewCard
      planMarkdown={PLAN}
      fallbackTitle="Proposed plan"
      environmentId={environmentId}
      threadRef={threadRef}
      cwd={undefined}
      findActive={false}
      isCopied={false}
      onDownload={vi.fn()}
      onCopy={vi.fn()}
      onSaveToWorkspace={null}
      onApprove={null}
      {...overrides}
    />
  );
}

function stepTexts(container: HTMLElement) {
  return [...container.querySelectorAll("[data-matter-plan-step-text]")].map(
    (step) => step.textContent,
  );
}

function resetDisarmedPlans() {
  resetDisarmedMatterPlanAutoApproveForTests();
  return {
    [Symbol.dispose]: resetDisarmedMatterPlanAutoApproveForTests,
  };
}

describe("MatterPlanOverviewCard", () => {
  it("shows the title, summary and first three to-dos with a count", async () => {
    await using screen = await render(card());
    await expect.element(screen.getByText("Plan Overview")).toBeVisible();
    await expect
      .element(screen.getByRole("heading", { name: "Session auth migration" }))
      .toBeVisible();
    await expect
      .element(screen.getByText(/Ship cookie-based sessions with middleware and tests\./))
      .toBeVisible();
    await expect.element(screen.getByText("To-dos")).toBeVisible();
    await expect
      .element(screen.container.querySelector<HTMLElement>("[data-matter-plan-count]"))
      .toHaveTextContent("6");
    expect(stepTexts(screen.container)).toEqual([
      "Add migration for sessions table",
      "Wire auth middleware",
      "Update login flow + tests",
    ]);
  });

  it("expands to every step and collapses again", async () => {
    await using screen = await render(card());
    await screen.getByRole("button", { name: "3 more" }).click();
    await expect.element(screen.getByRole("button", { name: "Show less" })).toBeVisible();
    expect(stepTexts(screen.container)).toHaveLength(6);
    expect(
      screen.container.querySelector<HTMLElement>("[data-matter-plan-step][data-done]"),
    ).not.toBeNull();
    await screen.getByRole("button", { name: "Show less" }).click();
    await expect.element(screen.getByRole("button", { name: "3 more" })).toBeVisible();
    expect(stepTexts(screen.container)).toHaveLength(3);
  });

  it("falls back to a markdown preview when the plan has no steps", async () => {
    await using screen = await render(
      card({ planMarkdown: "# Just prose\n\nNo lists here, only a paragraph." }),
    );
    await expect
      .element(screen.container.querySelector<HTMLElement>("[data-matter-plan-preview]"))
      .toBeInTheDocument();
    expect(
      screen.container.querySelector<HTMLElement>("[data-matter-plan-todos-header]"),
    ).toBeNull();
  });

  it("View Plan reveals the full markdown and Download calls back", async () => {
    const onDownload = vi.fn();
    await using screen = await render(card({ onDownload }));
    expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-full]")).toBeNull();
    await screen.getByRole("button", { name: "View Plan" }).click();
    await expect
      .element(screen.container.querySelector<HTMLElement>("[data-matter-plan-full]"))
      .toHaveAttribute("data-open", "");
    await expect.element(screen.getByRole("button", { name: "Hide Plan" })).toBeVisible();
    await screen.getByRole("button", { name: "Download as markdown" }).click();
    expect(onDownload).toHaveBeenCalledTimes(1);
  });

  it("opens the full plan dialog from the expand button", async () => {
    const onCopy = vi.fn();
    await using screen = await render(card({ onCopy }));
    await screen.getByRole("button", { name: "Open full plan" }).click();
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Copy to clipboard" }).click();
    expect(onCopy).toHaveBeenCalledTimes(1);
  });

  it("offers Approve only when actionable and sends the plan", async () => {
    const onApprove = vi.fn(() => new Promise<void>(() => {}));
    {
      await using screen = await render(card());
      await expect.element(screen.getByRole("button", { name: "View Plan" })).toBeVisible();
      expect(
        screen.container.querySelector<HTMLElement>('[data-matter-qp-pill-button="primary"]'),
      ).toBeNull();
    }
    await using screen = await render(card({ onApprove }));
    await screen.getByRole("button", { name: /Approve/ }).click();
    expect(onApprove).toHaveBeenCalledWith(PLAN);
    await expect.element(screen.getByRole("button", { name: /Approving/ })).toBeDisabled();
  });

  it("does not count down unless auto-approve is on", async () => {
    localStorage.removeItem(MATTER_PLAN_AUTO_APPROVE_STORAGE_KEY);
    await using screen = await render(card({ onApprove: vi.fn(async () => {}) }));
    await expect.element(screen.getByRole("button", { name: /Approve/ })).toBeVisible();
    expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).toBeNull();
  });

  it("auto-approves after the countdown when the device setting is on", async () => {
    writeMatterPlanAutoApprove(true);
    using _timers = fakeTimers();
    const onApprove = vi.fn(async () => {});
    try {
      await using screen = await render(card({ onApprove }));
      const label = () =>
        screen.container.querySelector<HTMLElement>("[data-matter-plan-auto-label]");
      expect(label()?.textContent).toBe("Auto Approve in 30s");
      await act(() => vi.advanceTimersByTime(3_000));
      expect(label()?.textContent).toBe("Auto Approve in 27s");
      expect(onApprove).not.toHaveBeenCalled();
      await act(() => vi.advanceTimersByTime(27_000));
      expect(onApprove).toHaveBeenCalledTimes(1);
    } finally {
      localStorage.removeItem(MATTER_PLAN_AUTO_APPROVE_STORAGE_KEY);
    }
  });

  it("hovering the ring pauses the countdown, keeps Cancel inside the card, and clicking stops auto-approve", async () => {
    using _timers = fakeTimers();
    const onApprove = vi.fn(async () => {});
    await using screen = await render(card({ onApprove, autoApprove: true }));
    const label = () =>
      screen.container.querySelector<HTMLElement>("[data-matter-plan-auto-label]");
    const ring = screen.getByRole("button", { name: "Cancel auto-approve" });
    await act(() => vi.advanceTimersByTime(3_000));
    expect(label()?.textContent).toBe("Auto Approve in 27s");

    await userEvent.hover(ring);
    const tip = screen.container.querySelector<HTMLElement>("[data-matter-plan-auto-tip]")!;
    const cardEl = screen.container.querySelector<HTMLElement>("[data-matter-plan]")!;
    await expect.element(tip).toHaveStyle({ opacity: "1" });
    expect(tip.getBoundingClientRect().left).toBeGreaterThanOrEqual(
      cardEl.getBoundingClientRect().left,
    );

    // Pausing prevents the countdown from firing under the cursor.
    await act(() => vi.advanceTimersByTime(40_000));
    expect(label()?.textContent).toBe("Auto Approve in 27s");
    expect(onApprove).not.toHaveBeenCalled();

    // Unhovering resumes from the paused remaining time; keyboard focus also pauses.
    await userEvent.unhover(ring);
    await act(() => vi.advanceTimersByTime(2_000));
    expect(label()?.textContent).toBe("Auto Approve in 25s");

    const ringButton = screen.container.querySelector<HTMLButtonElement>(
      "[data-matter-plan-auto-ring]",
    )!;
    await act(() => ringButton.focus());
    await act(() => vi.advanceTimersByTime(40_000));
    expect(label()?.textContent).toBe("Auto Approve in 25s");
    expect(onApprove).not.toHaveBeenCalled();

    await ring.click();
    expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).toBeNull();
    await expect.element(screen.getByRole("button", { name: /Approve/ })).toBeEnabled();
    await act(() => vi.advanceTimersByTime(40_000));
    expect(onApprove).not.toHaveBeenCalled();
  });

  it("keeps cancelled auto-approve disarmed across unmount and remount", async () => {
    using _reset = resetDisarmedPlans();
    const planId = PlanId.make("plan-virtualized");
    const onApprove = vi.fn(async () => {});
    {
      await using screen = await render(card({ planId, onApprove, autoApprove: true }));
      await screen.getByRole("button", { name: "Cancel auto-approve" }).click();
      expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).toBeNull();
    }
    await using remounted = await render(card({ planId, onApprove, autoApprove: true }));
    expect(remounted.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).toBeNull();
  });

  it("disarms auto-approve when View Plan or Open full plan is clicked", async () => {
    using _reset = resetDisarmedPlans();
    using _timers = fakeTimers();
    const onApprove = vi.fn(async () => {});
    {
      await using screen = await render(
        card({ planId: PlanId.make("plan-view"), onApprove, autoApprove: true }),
      );
      expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).not.toBeNull();
      await screen.getByRole("button", { name: "View Plan" }).click();
      expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).toBeNull();
      await act(() => vi.advanceTimersByTime(40_000));
      expect(onApprove).not.toHaveBeenCalled();
    }
    {
      await using screen = await render(
        card({ planId: PlanId.make("plan-dialog"), onApprove, autoApprove: true }),
      );
      expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).not.toBeNull();
      await screen.getByRole("button", { name: "Open full plan" }).click();
      expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).toBeNull();
      await act(() => vi.advanceTimersByTime(40_000));
      expect(onApprove).not.toHaveBeenCalled();
    }
  });

  it("does not arm auto-approve when autoApproveEligible is false", async () => {
    await using screen = await render(
      card({ onApprove: vi.fn(async () => {}), autoApprove: true, autoApproveEligible: false }),
    );
    expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-auto]")).toBeNull();
    await expect.element(screen.getByRole("button", { name: /Approve/ })).toBeEnabled();
  });

  it("hides the preview when View Plan opens a step-less plan", async () => {
    await using screen = await render(
      card({ planMarkdown: "# Just prose\n\nNo lists here, only a paragraph." }),
    );
    expect(
      screen.container.querySelector<HTMLElement>("[data-matter-plan-preview]"),
    ).not.toBeNull();
    await screen.getByRole("button", { name: "View Plan" }).click();
    expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-preview]")).toBeNull();
    expect(screen.container.querySelector<HTMLElement>("[data-matter-plan-full]")).not.toBeNull();
  });

  it("suppresses error toasts when approval is interrupted and resets approving state", async () => {
    const addToastSpy = vi.spyOn(toastManager, "add");
    const onApprove = vi.fn(async () => AsyncResult.failure(Cause.interrupt()));
    try {
      await using screen = await render(card({ onApprove }));
      await screen.getByRole("button", { name: /Approve/ }).click();
      await expect.element(screen.getByRole("button", { name: /Approve/ })).toBeEnabled();
      expect(addToastSpy).not.toHaveBeenCalled();
    } finally {
      addToastSpy.mockRestore();
    }
  });
});
