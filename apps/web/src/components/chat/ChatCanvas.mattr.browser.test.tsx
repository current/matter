import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useState, type CSSProperties } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import shellCss from "../../../../../antimatter/shell.css?inline";
import indexCss from "../../index.css?inline";
import { act, render } from "../../../test/render";
import { usePanelPresence } from "../../panelAnimations";
import { useRightPanelStore } from "../../rightPanelStore";
import { createChatCanvasStore } from "./canvasStore";
import { ChatCanvas } from "./ChatCanvas";
import { ThreadDetailsCard } from "./ThreadDetailsCard";
import { PreviewPanelShell } from "../preview/PreviewPanelShell";
import { PopoverCreateHandle } from "../ui/popover";
import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "../../hooks/useSettings";

const THREAD_REF: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const ANIMATION_MS = 260;
const PANEL_WIDTH = 540;

const NOOP_RESIZE_HANDLERS = {
  ref: () => undefined,
  onPointerDown: () => {},
  onPointerMove: () => {},
  onPointerUp: () => {},
  onPointerCancel: () => {},
  onLostPointerCapture: () => {},
};

function Harness({
  containerWidth,
  rightPanelOpen,
}: {
  containerWidth: number;
  rightPanelOpen: boolean;
}) {
  const [store] = useState(createChatCanvasStore);
  const [handle] = useState(PopoverCreateHandle);
  const [anchor] = useState(() => ({ current: null as Element | null }));
  const presence = usePanelPresence(rightPanelOpen, "diff", true, "thread-1", ANIMATION_MS);

  return (
    <div
      data-slot="sidebar-wrapper"
      data-panel-animations="true"
      style={
        {
          "--panel-animation-duration": `${ANIMATION_MS}ms`,
          "--chat-content-max-width": "48rem",
          "--html-preview-max-width": "48rem",
          width: containerWidth,
          height: 760,
          display: "flex",
        } as CSSProperties
      }
    >
      <div
        data-slot="sidebar-inset"
        style={{
          display: "flex",
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          margin: 0,
        }}
      >
        <div
          style={{
            position: "relative",
            display: "flex",
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div
            data-chat-column
            style={{
              display: "flex",
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              flexDirection: "column",
              overflowX: "hidden",
            }}
          >
            <header data-chat-header style={{ height: 38, flexShrink: 0 }} />
            <div
              style={{ position: "relative", display: "flex", flex: 1, minWidth: 0, minHeight: 0 }}
            >
              <ChatCanvas
                store={store}
                threadRef={THREAD_REF}
                preview={null}
                composerOverlayElement={null}
              >
                <div
                  className="messages-timeline-scroll"
                  style={{ flex: 1, minHeight: 0, width: "100%" }}
                >
                  <div
                    data-testid="chat-message"
                    style={{
                      marginInline: "auto",
                      maxWidth: "var(--chat-content-max-width)",
                      height: 80,
                    }}
                  >
                    Chat message content that should never double-bounce when closing a right panel.
                  </div>
                </div>
                <ThreadDetailsCard
                  threadRef={THREAD_REF}
                  anchor={anchor}
                  handle={handle}
                  contentKey="details"
                >
                  {() => <div style={{ height: 240 }}>Thread details content</div>}
                </ThreadDetailsCard>
              </ChatCanvas>
            </div>
          </div>

          {presence.present ? (
            <PreviewPanelShell
              mode="inline"
              open={rightPanelOpen}
              inlineSize={{
                width: PANEL_WIDTH,
                handlers: NOOP_RESIZE_HANDLERS,
                observeRow: () => () => {},
              }}
            >
              <div data-right-panel-surface-content style={{ flex: 1 }}>
                Right panel content
              </div>
            </PreviewPanelShell>
          ) : null}
        </div>
      </div>
    </div>
  );
}

async function mountFixture() {
  await page.viewport(1400, 900);
  useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    panelAnimationDurationMs: ANIMATION_MS,
  });
  const style = document.createElement("style");
  style.textContent = `${indexCss}\n${shellCss}`;
  document.head.append(style);
  return {
    [Symbol.dispose]() {
      style.remove();
      __resetClientSettingsPersistenceForTests();
      useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
    },
  };
}

function runningPanelTransitions() {
  const panel = document.querySelector<HTMLElement>('[data-preview-panel-mode="inline"]');
  if (!panel) return [];
  return panel
    .getAnimations()
    .filter(
      (animation): animation is CSSTransition =>
        animation instanceof CSSTransition && animation.playState === "running",
    );
}

async function waitForPanelTransitions(): Promise<CSSTransition[]> {
  let transitions: CSSTransition[] = [];
  await vi.waitFor(() => {
    transitions = runningPanelTransitions();
    expect(transitions.length).toBeGreaterThan(0);
  });
  return transitions;
}

function scrubTransitions(
  transitions: CSSTransition[],
  messageEl: Element,
): Array<{ readonly timeMs: number; readonly chatLeft: number; readonly chatWidth: number }> {
  for (const animation of transitions) animation.pause();
  const samples: Array<{
    readonly timeMs: number;
    readonly chatLeft: number;
    readonly chatWidth: number;
  }> = [];
  for (let timeMs = 0; timeMs <= ANIMATION_MS; timeMs += 20) {
    for (const animation of transitions) animation.currentTime = timeMs;
    const rect = messageEl.getBoundingClientRect();
    samples.push({ timeMs, chatLeft: rect.left, chatWidth: rect.width });
  }
  for (const animation of transitions) animation.finish();
  return samples;
}

describe("ChatCanvas right panel and Thread Details transitions", () => {
  it("reopens Thread Details immediately as the Right Panel closes with zero chat width or position bounce", async () => {
    using _fixture = await mountFixture();
    // 1050px minus 2px inset border = 1048px canvas -> 676px chat beside the 280px details card.
    await using screen = await render(<Harness containerWidth={1050} rightPanelOpen={false} />);

    const detailsLocator = page.getByText("Thread details content");
    await expect.element(detailsLocator).toBeVisible();
    const messageEl = screen.getByTestId("chat-message").element();
    const baselineRect = messageEl.getBoundingClientRect();
    expect(baselineRect.width).toBeCloseTo(676, 0);

    // Open the Right Panel and finish its slide; Thread Details auto-hides.
    await screen.rerender(<Harness containerWidth={1050} rightPanelOpen />);
    for (const animation of await waitForPanelTransitions()) animation.finish();
    await expect.element(detailsLocator).not.toBeInTheDocument();
    const openPanelRect = messageEl.getBoundingClientRect();
    expect(openPanelRect.width).toBeLessThan(baselineRect.width - 150);

    // Close the Right Panel: Thread Details must mount while the panel is still actively closing.
    await screen.rerender(<Harness containerWidth={1050} rightPanelOpen={false} />);
    const closeTransitions = await waitForPanelTransitions();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
    });
    const panelMidCloseWidth = document
      .querySelector<HTMLElement>('[data-preview-panel-mode="inline"]')!
      .getBoundingClientRect().width;
    expect(panelMidCloseWidth).toBeGreaterThan(100);

    // Scrub the full 260ms close curve and verify zero width/left overshoot and monotonic widening.
    const samples = scrubTransitions(closeTransitions, messageEl);
    let peakWidth = samples[0]!.chatWidth;
    let peakLeft = samples[0]!.chatLeft;
    for (const sample of samples) {
      expect(sample.chatWidth).toBeLessThanOrEqual(baselineRect.width + 0.5);
      expect(sample.chatLeft).toBeLessThanOrEqual(baselineRect.left + 0.5);
      expect(sample.chatWidth).toBeGreaterThanOrEqual(peakWidth - 0.5);
      expect(sample.chatLeft).toBeGreaterThanOrEqual(peakLeft - 0.5);
      peakWidth = Math.max(peakWidth, sample.chatWidth);
      peakLeft = Math.max(peakLeft, sample.chatLeft);
    }

    await vi.waitFor(() => {
      expect(document.querySelector('[data-preview-panel-mode="inline"]')).toBeNull();
    });
    const finalRect = messageEl.getBoundingClientRect();
    expect(finalRect.width).toBeCloseTo(baselineRect.width, 0);
    expect(finalRect.left).toBeCloseTo(baselineRect.left, 0);
    await expect.element(detailsLocator).toBeVisible();
  });

  it("prevents horizontal left-shift bounce at wider viewports where chat stays at max width", async () => {
    using _fixture = await mountFixture();
    await using screen = await render(<Harness containerWidth={1180} rightPanelOpen={false} />);

    const detailsLocator = page.getByText("Thread details content");
    await expect.element(detailsLocator).toBeVisible();
    const messageEl = screen.getByTestId("chat-message").element();
    const baselineRect = messageEl.getBoundingClientRect();

    await screen.rerender(<Harness containerWidth={1180} rightPanelOpen />);
    for (const animation of await waitForPanelTransitions()) animation.finish();
    await expect.element(detailsLocator).not.toBeInTheDocument();

    await screen.rerender(<Harness containerWidth={1180} rightPanelOpen={false} />);
    const closeTransitions = await waitForPanelTransitions();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-thread-details-panel="inline"]')).not.toBeNull();
    });

    const samples = scrubTransitions(closeTransitions, messageEl);
    for (const sample of samples) {
      expect(sample.chatLeft).toBeLessThanOrEqual(baselineRect.left + 0.5);
    }

    await vi.waitFor(() => {
      expect(document.querySelector('[data-preview-panel-mode="inline"]')).toBeNull();
    });
    const finalRect = messageEl.getBoundingClientRect();
    expect(finalRect.left).toBeCloseTo(baselineRect.left, 0);
    expect(finalRect.width).toBeCloseTo(baselineRect.width, 0);
  });

  it("keeps full-width widening when Thread Details is closed", async () => {
    using _fixture = await mountFixture();
    await act(() => useRightPanelStore.getState().setThreadPanelOpen(THREAD_REF, "inline", false));
    await using screen = await render(<Harness containerWidth={1050} rightPanelOpen />);
    for (const animation of await waitForPanelTransitions()) animation.finish();

    await screen.rerender(<Harness containerWidth={1050} rightPanelOpen={false} />);
    for (const animation of await waitForPanelTransitions()) animation.finish();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-preview-panel-mode="inline"]')).toBeNull();
    });

    await expect.element(page.getByText("Thread details content")).not.toBeInTheDocument();
    const finalRect = screen.getByTestId("chat-message").element().getBoundingClientRect();
    expect(finalRect.width).toBeCloseTo(768, 0);
  });

  it("hides Thread Details on Right Panel open without bouncing chat wider first", async () => {
    using _fixture = await mountFixture();
    await using screen = await render(<Harness containerWidth={1050} rightPanelOpen={false} />);

    const detailsLocator = page.getByText("Thread details content");
    await expect.element(detailsLocator).toBeVisible();
    const messageEl = screen.getByTestId("chat-message").element();
    const baselineRect = messageEl.getBoundingClientRect();

    await screen.rerender(<Harness containerWidth={1050} rightPanelOpen />);
    const openTransitions = await waitForPanelTransitions();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-thread-details-panel="inline"]')).toBeNull();
    });

    const samples = scrubTransitions(openTransitions, messageEl);
    for (const sample of samples) {
      expect(sample.chatWidth).toBeLessThanOrEqual(baselineRect.width + 0.5);
    }
  });
});
