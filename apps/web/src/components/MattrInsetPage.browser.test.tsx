import type { AnyRouter } from "@tanstack/react-router";
import { useLocation } from "@tanstack/react-router";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { useCommitOnBlur } from "../hooks/useCommitOnBlur";
import { startMainAppLocationTracking } from "./sidebar/mainAppLocation";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import { MattrInsetPage } from "./MattrInsetPage";

vi.mock("./chat/GlobalVoiceInputIndicator", () => ({ GlobalVoiceInputIndicator: () => null }));

const THREAD_PATH = "/environment-one/thread-one";

function CommitOnBlurField({ onCommit }: { onCommit: (next: string) => void }) {
  return <input aria-label="Instructions" {...useCommitOnBlur("", onCommit)} />;
}

function SettingsRoute({ children }: { children?: React.ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  return pathname.startsWith("/settings") ? (
    <MattrInsetPage label="Settings" breadcrumb={<span>General</span>}>
      {children}
    </MattrInsetPage>
  ) : (
    <p>Thread view</p>
  );
}

async function settled(router: AnyRouter, navigation: Promise<void>) {
  await navigation;
  await vi.waitFor(() =>
    expect(router.state.resolvedLocation?.href).toBe(router.state.location.href),
  );
}

async function openFromThread(children?: React.ReactNode) {
  const screen = await render(<SettingsRoute>{children}</SettingsRoute>, { router: "/" });
  const router = screen.router!;
  await settled(router, router.navigate({ href: THREAD_PATH }));
  const stopTracking = startMainAppLocationTracking(router);
  await settled(router, router.navigate({ href: "/settings/general" }));
  return {
    router,
    async [Symbol.asyncDispose]() {
      stopTracking();
      await screen[Symbol.asyncDispose]();
    },
  };
}

describe("MattrInsetPage", () => {
  it("renders inline in the shell card, not in a dialog", async () => {
    await using _settings = await openFromThread();

    const region = page.getByRole("region", { name: "Settings" });
    await expect.element(region).toHaveFocus();
    const element = region.element() as HTMLElement;
    expect(element.closest('[data-slot="sidebar-inset"]')).not.toBeNull();
    expect(element.previousElementSibling?.hasAttribute("data-workspace-page-header")).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("returns to the opening thread from the close button", async () => {
    await using settings = await openFromThread();

    await page.getByRole("button", { name: "Close" }).click();

    await vi.waitFor(() => expect(settings.router.state.location.pathname).toBe(THREAD_PATH));
    await expect.element(page.getByText("Thread view")).toBeVisible();
  });

  it("commits a focused field and returns to the thread on Esc", async () => {
    const onCommit = vi.fn();
    await using settings = await openFromThread(<CommitOnBlurField onCommit={onCommit} />);

    await page.getByRole("textbox", { name: "Instructions" }).fill("Keep titles short");
    await userEvent.keyboard("{Escape}");

    expect(onCommit).toHaveBeenCalledWith("Keep titles short");
    await vi.waitFor(() => expect(settings.router.state.location.pathname).toBe(THREAD_PATH));
  });

  it("leaves Esc to an open menu", async () => {
    await using settings = await openFromThread(
      <Menu>
        <MenuTrigger>All providers</MenuTrigger>
        <MenuPopup>
          <MenuItem>Claude</MenuItem>
        </MenuPopup>
      </Menu>,
    );
    await page.getByRole("button", { name: "All providers" }).click();
    await expect.element(page.getByRole("menu")).toBeVisible();

    await userEvent.keyboard("{Escape}");

    await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
    expect(settings.router.state.location.pathname).toBe("/settings/general");
  });
});
