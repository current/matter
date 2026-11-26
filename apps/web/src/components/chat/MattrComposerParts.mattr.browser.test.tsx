import "~/index.css";
import "../../../../../antimatter/composer.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { act, render } from "../../../test/render";

import { ComposerSurface } from "./ComposerSurface";
import { MattrComposerAttachButton, MattrComposerProjectLabel } from "./MattrComposerParts.mattr";

function Composer(props: { readonly sendDisabled: boolean; readonly contextRow: boolean }) {
  return (
    <div style={{ width: 640 }}>
      <ComposerSurface.Shell data-mattr-composer="" contextRow={props.contextRow}>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div data-chat-composer-surface="true">
              <div data-chat-composer-body="true" />
              <div data-chat-composer-footer="true" className="flex">
                <div className="me-2">
                  <MattrComposerAttachButton onOpenPicker={() => {}} />
                </div>
                <div data-chat-composer-actions="right" className="flex flex-1">
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
                  <button type="submit" disabled={props.sendDisabled}>
                    Send
                  </button>
                </div>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
        {props.contextRow ? (
          <ComposerSurface.ContextStrip>
            <MattrComposerProjectLabel title="mattr" />
          </ComposerSurface.ContextStrip>
        ) : null}
      </ComposerSurface.Shell>
    </div>
  );
}

const style = (element: Element) => getComputedStyle(element);
const shell = () => document.querySelector("[data-mattr-composer]")!;

describe("final choice composer", () => {
  it("wraps the card and under-tray in one shelf", async () => {
    await using _ = await render(<Composer sendDisabled contextRow />);
    expect(style(shell()).borderTopLeftRadius).toBe("17px");
    expect(style(shell()).paddingTop).toBe("4px");
    expect(style(shell()).paddingBottom).toBe("0px");
    const host = document.querySelector('[data-slot="composer-host"]')!;
    expect(style(host).borderTopLeftRadius).toBe("13px");
    const strip = document.querySelector('[data-slot="composer-context-strip"]')!;
    expect(style(strip).minHeight).toBe("38px");
    expect(document.querySelector("[data-mattr-composer-project-name]")?.textContent).toBe("mattr");
  });

  it("pads the shelf evenly when no under-tray shows", async () => {
    await using _ = await render(<Composer sendDisabled contextRow={false} />);
    expect(style(shell()).paddingBottom).toBe("4px");
  });

  it("draws send as a red circle once there is something to send", async () => {
    await using _ = await render(<Composer sendDisabled={false} contextRow />);
    const send = document.querySelector('button[type="submit"]')!;
    expect(style(send).width).toBe("28px");
    expect(style(send).backgroundColor).toBe("rgb(229, 72, 77)");
  });

  it("keeps send quiet while the prompt is empty", async () => {
    await using _ = await render(<Composer sendDisabled contextRow />);
    const send = document.querySelector('button[type="submit"]')!;
    expect(style(send).backgroundColor).not.toBe("rgb(229, 72, 77)");
  });

  it("moves permissions to the left of the footer", async () => {
    await using _ = await render(<Composer sendDisabled contextRow />);
    const mode = document.querySelector('[data-resting-block="mode"]')!;
    const picker = document.querySelector("[data-chat-provider-model-picker]")!;
    expect(mode.getBoundingClientRect().right).toBeLessThan(picker.getBoundingClientRect().left);
  });

  it("opens the file picker from the plus button", async () => {
    const onOpenPicker = vi.fn();
    await using screen = await render(<MattrComposerAttachButton onOpenPicker={onOpenPicker} />);
    const button = screen.getByRole("button", { name: "Attach files" }).element() as HTMLElement;
    await act(() => button.click());
    expect(onOpenPicker).toHaveBeenCalledTimes(1);
  });
});
