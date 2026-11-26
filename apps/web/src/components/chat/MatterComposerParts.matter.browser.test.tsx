import "~/index.css";
import "../../../../../matter/composer.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";

import {
  MATTER_GOOEY_SEND_STORAGE_KEY,
  useMatterGooeySendSetting,
  writeMatterGooeySend,
} from "../../matterGooeySend";
import { ComposerSurface } from "./ComposerSurface";
import {
  MatterComposerAttachButton,
  MatterComposerProjectLabel,
  MatterDictateIcon,
  MatterGooeySendAnchor,
  type MatterGooeySendAction,
  MatterVoiceModeIcon,
} from "./MatterComposerParts.matter";

function gooeySetting(enabled: boolean): Disposable {
  writeMatterGooeySend(enabled);
  return { [Symbol.dispose]: () => localStorage.removeItem(MATTER_GOOEY_SEND_STORAGE_KEY) };
}

function reduceMotion(matches: boolean): Disposable {
  const real = window.matchMedia.bind(window);
  const spy = vi.spyOn(window, "matchMedia").mockImplementation((query) =>
    query === "(prefers-reduced-motion: reduce)"
      ? ({
          matches,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        } as unknown as MediaQueryList)
      : real(query),
  );
  return { [Symbol.dispose]: () => spy.mockRestore() };
}

function Composer(props: {
  readonly sendDisabled: boolean;
  readonly contextRow: boolean;
  readonly activeThread?: boolean;
  readonly onSubmit?: () => void;
  readonly onDictate?: () => void;
  readonly onVoiceMode?: () => void;
}) {
  const [gooeySend] = useMatterGooeySendSetting();
  const actions: MatterGooeySendAction[] = [
    {
      id: "dictate",
      label: "Dictate",
      shortcut: "Alt+Space",
      icon: <MatterDictateIcon />,
      onSelect: () => props.onDictate?.(),
    },
    {
      id: "voice-mode",
      label: "Voice mode",
      icon: <MatterVoiceModeIcon />,
      onSelect: () => props.onVoiceMode?.(),
    },
  ];
  const sendButton = (
    <span className="inline-flex">
      <button
        type="submit"
        className="rounded-full disabled:pointer-events-none"
        disabled={props.sendDisabled}
      >
        Send
      </button>
    </span>
  );

  return (
    <div style={{ width: 640 }}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit?.();
        }}
      >
        <ComposerSurface.Shell data-matter-composer="" contextRow={props.contextRow}>
          <ComposerSurface.Host>
            <ComposerSurface.Main>
              <div data-chat-composer-surface="true">
                <div data-chat-composer-body="true" />
                <div data-chat-composer-footer="true" className="flex items-center">
                  <div className="me-2">
                    <MatterComposerAttachButton onOpenPicker={() => {}} />
                  </div>
                  <div data-chat-composer-actions="right" className="flex flex-1 items-center">
                    <div
                      data-chat-composer-footer-controls="true"
                      className="flex flex-1 justify-end"
                    >
                      <button type="button" data-chat-provider-model-picker="true">
                        Opus 5.5
                      </button>
                      <div data-resting-block="mode" data-composer-block-icon-only="false">
                        <button type="button">Full access</button>
                      </div>
                    </div>
                    {!gooeySend ? (
                      <>
                        <button
                          type="button"
                          aria-label="Start voice input"
                          onClick={() => props.onDictate?.()}
                        >
                          <MatterDictateIcon />
                        </button>
                        <button
                          type="button"
                          aria-label="Start voice mode"
                          onClick={() => props.onVoiceMode?.()}
                        >
                          <MatterVoiceModeIcon />
                        </button>
                      </>
                    ) : null}
                    {gooeySend ? (
                      <MatterGooeySendAnchor actions={actions} anchorActive={!props.sendDisabled}>
                        {sendButton}
                      </MatterGooeySendAnchor>
                    ) : (
                      sendButton
                    )}
                  </div>
                </div>
              </div>
            </ComposerSurface.Main>
          </ComposerSurface.Host>
          {props.contextRow ? (
            <ComposerSurface.ContextStrip>
              <MatterComposerProjectLabel title="Matter" />
              <div className="flex flex-1 items-center">
                {props.activeThread ? (
                  <span data-composer-context-control="">t3-gooey</span>
                ) : (
                  <button
                    type="button"
                    data-composer-shortcut="composer.workspace"
                    data-composer-context-control=""
                  >
                    New worktree
                  </button>
                )}
              </div>
              <div className="flex items-center">
                <button type="button" data-slot="combobox-trigger">
                  {props.activeThread ? "t3/gooey-composer-polish" : "From main"}
                </button>
              </div>
              <button
                type="button"
                aria-haspopup="menu"
                data-composer-context-control=""
                className="ms-auto"
              >
                Full access
              </button>
            </ComposerSurface.ContextStrip>
          ) : null}
        </ComposerSurface.Shell>
      </form>
    </div>
  );
}

const style = (element: Element) => getComputedStyle(element);
const shell = () => document.querySelector("[data-matter-composer]")!;

describe("final choice composer", () => {
  it("wraps the card and under-tray in one shelf with identical order in drafts and active threads", async () => {
    await using screen = await render(<Composer sendDisabled contextRow />, { router: false });
    const assertTrayLayout = (workspaceSelector: string) => {
      expect(style(shell()).borderTopLeftRadius).toBe("17px");
      expect(style(shell()).paddingTop).toBe("4px");
      expect(style(shell()).paddingBottom).toBe("0px");
      const host = document.querySelector('[data-slot="composer-host"]')!;
      expect(style(host).borderTopLeftRadius).toBe("13px");
      const strip = document.querySelector('[data-slot="composer-context-strip"]')!;
      expect(style(strip).minHeight).toBe("38px");
      const project = document.querySelector("[data-matter-composer-project]")!;
      const workspace = document.querySelector(workspaceSelector)!;
      const permissions = document.querySelector(
        '[data-slot="composer-context-strip"] button[aria-haspopup="menu"]',
      )!;
      const branch = document.querySelector('button[data-slot="combobox-trigger"]')!;
      expect(project.getBoundingClientRect().right).toBeLessThanOrEqual(
        workspace.getBoundingClientRect().left + 1,
      );
      expect(workspace.getBoundingClientRect().right).toBeLessThanOrEqual(
        permissions.getBoundingClientRect().left + 1,
      );
      expect(permissions.getBoundingClientRect().right).toBeLessThan(
        branch.getBoundingClientRect().left,
      );
    };

    assertTrayLayout('[data-composer-shortcut="composer.workspace"]');

    await screen.rerender(<Composer sendDisabled contextRow activeThread />);
    assertTrayLayout("span[data-composer-context-control]");
  });

  it("collapses the outer cradle cleanly with no empty rim when no under-tray shows", async () => {
    await using _ = await render(<Composer sendDisabled contextRow={false} />, { router: false });
    expect(style(shell()).paddingTop).toBe("0px");
    expect(style(shell()).paddingBottom).toBe("0px");
    expect(style(shell()).borderTopWidth).toBe("0px");
    expect(style(shell()).borderTopLeftRadius).toBe("13px");
  });

  it("draws send as a red circle once there is something to send", async () => {
    await using _ = await render(<Composer sendDisabled={false} contextRow />, { router: false });
    const send = document.querySelector('button[type="submit"]')!;
    expect(style(send).width).toBe("28px");
    expect(style(send).backgroundColor).toBe("rgb(229, 72, 77)");
  });

  it("keeps send quiet while the prompt is empty", async () => {
    await using _ = await render(<Composer sendDisabled contextRow />, { router: false });
    const send = document.querySelector('button[type="submit"]')!;
    expect(style(send).backgroundColor).not.toBe("rgb(229, 72, 77)");
  });

  it("moves permissions to the left of the footer", async () => {
    await using _ = await render(<Composer sendDisabled contextRow />, { router: false });
    const mode = document.querySelector('[data-resting-block="mode"]')!;
    const picker = document.querySelector("[data-chat-provider-model-picker]")!;
    expect(mode.getBoundingClientRect().right).toBeLessThan(picker.getBoundingClientRect().left);
  });

  it("opens the file picker from the plus button", async () => {
    const onOpenPicker = vi.fn();
    await using screen = await render(<MatterComposerAttachButton onOpenPicker={onOpenPicker} />, {
      router: false,
    });
    const button = screen.getByRole("button", { name: "Attach files" }).element() as HTMLElement;
    await act(() => button.click());
    expect(onOpenPicker).toHaveBeenCalledTimes(1);
  });
});

describe("gooey send button", () => {
  it("switches between inline voice buttons when off and right-click pop-out when on", async () => {
    using _setting = gooeySetting(false);
    const onDictate = vi.fn();
    const onVoiceMode = vi.fn();
    await using _screen = await render(
      <Composer sendDisabled contextRow onDictate={onDictate} onVoiceMode={onVoiceMode} />,
      { router: false },
    );

    const inlineMic = page.getByRole("button", { name: "Start voice input" });
    const inlineVoice = page.getByRole("button", { name: "Start voice mode" });
    await expect.element(inlineMic).toBeVisible();
    await expect.element(inlineVoice).toBeVisible();
    expect(document.querySelector('[data-matter-icon="dictate"]')).not.toBeNull();
    expect(document.querySelector('[data-matter-icon="voice-mode"]')).not.toBeNull();
    expect(document.querySelector("[data-matter-gooey-anchor]")).toBeNull();

    await act(() => writeMatterGooeySend(true));
    await expect.element(inlineMic).not.toBeInTheDocument();
    await expect.element(inlineVoice).not.toBeInTheDocument();
    expect(document.querySelector("[data-matter-gooey-anchor]")).not.toBeNull();
    // Idle state mounts zero SVG filters.
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();
    expect(document.querySelector("feGaussianBlur")).toBeNull();
  });

  it("pops out Dictate and Voice mode on right-click, runs actions, and leaves zero idle filter", async () => {
    using _setting = gooeySetting(true);
    using _motion = reduceMotion(false);
    const onDictate = vi.fn();
    const onVoiceMode = vi.fn();
    const onSubmit = vi.fn();
    await using _screen = await render(
      <Composer
        sendDisabled
        contextRow
        onSubmit={onSubmit}
        onDictate={onDictate}
        onVoiceMode={onVoiceMode}
      />,
      { router: false },
    );
    using _timers = fakeTimers();

    const anchor = document.querySelector("[data-matter-gooey-anchor]")!;
    const openEvent = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    await act(() => {
      anchor.dispatchEvent(openEvent);
    });
    expect(openEvent.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-matter-gooey-svg]")).not.toBeNull();
    expect(document.querySelector("feGaussianBlur")).not.toBeNull();
    expect(document.querySelector("feColorMatrix")).not.toBeNull();

    const dictate = page.getByRole("button", { name: "Dictate" });
    const voiceMode = page.getByRole("button", { name: "Voice mode" });
    await expect.element(dictate).toBeVisible();
    await expect.element(voiceMode).toBeVisible();

    await act(() => (dictate.element() as HTMLButtonElement).click());
    expect(onDictate).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();
    expect(document.querySelector("feGaussianBlur")).toBeNull();

    // Reopen and trigger Voice Mode.
    await act(() => {
      anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await act(() =>
      (page.getByRole("button", { name: "Voice mode" }).element() as HTMLButtonElement).click(),
    );
    expect(onVoiceMode).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();
  });

  it("closes cleanly on Escape, outside pointerdown, or second right-click, and keeps left-click submit working", async () => {
    using _setting = gooeySetting(true);
    using _motion = reduceMotion(false);
    const onSubmit = vi.fn();
    await using _screen = await render(
      <Composer sendDisabled={false} contextRow onSubmit={onSubmit} />,
      { router: false },
    );
    using _timers = fakeTimers();

    const anchor = document.querySelector("[data-matter-gooey-anchor]")!;
    const sendButton = document.querySelector('button[type="submit"]') as HTMLButtonElement;

    // Left-click submits normally.
    await act(() => sendButton.click());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();

    // Open -> Escape closes.
    await act(() => {
      sendButton.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector("[data-matter-gooey-svg]")).not.toBeNull();
    await act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();

    // Open -> outside click closes.
    await act(() => {
      anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector("[data-matter-gooey-svg]")).not.toBeNull();
    await act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    });
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();

    // Open -> second right-click toggles closed.
    await act(() => {
      anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector("[data-matter-gooey-svg]")).not.toBeNull();
    await act(() => {
      anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await act(() => vi.advanceTimersByTime(400));
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();
  });

  it("skips the SVG blur filter and snaps cleanly under reduced motion", async () => {
    using _setting = gooeySetting(true);
    using _motion = reduceMotion(true);
    await using _screen = await render(<Composer sendDisabled contextRow />, { router: false });

    const anchor = document.querySelector("[data-matter-gooey-anchor]")!;
    await act(() => {
      anchor.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    await expect.element(page.getByRole("button", { name: "Dictate" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Voice mode" })).toBeVisible();
    expect(document.querySelector("[data-matter-gooey-svg]")).toBeNull();
    expect(document.querySelector("feGaussianBlur")).toBeNull();

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("button", { name: "Dictate" })).not.toBeInTheDocument();
  });
});
