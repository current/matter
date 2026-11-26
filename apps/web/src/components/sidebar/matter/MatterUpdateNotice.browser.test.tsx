/* oxlint-disable shadcn/no-unknown-classes -- the `mfs-*` classes come from the fork stylesheet antimatter/sidebar.css, which loads outside Tailwind. */
import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";
import "../../../../../../antimatter/sidebar.css";
import { act, render } from "../../../../test/render";
import { SidebarProvider } from "../../ui/sidebar";

const mocks = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  return {
    update: null as DesktopUpdateState | null,
    hasUpdates: false,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify: () => {
      for (const listener of listeners) listener();
    },
  };
});
vi.mock("../../../state/desktopUpdate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../state/desktopUpdate")>()),
  useDesktopUpdateState: (await import("react")).useSyncExternalStore.bind(
    null,
    mocks.subscribe,
    () => mocks.update,
  ),
}));
vi.mock("../../../env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../env")>()),
  isElectron: true,
}));
vi.mock("../useUpdateEverything", () => ({
  useUpdateEverything: () => ({
    hasUpdates: mocks.hasUpdates,
    summary: "Update everything",
    version: null,
    providerCount: 0,
    rows: [],
    restarts: [],
  }),
}));

import { MattrUpdateNotice } from "./MattrDefaultSidebarParts";

function updateState(status: DesktopUpdateState["status"]): DesktopUpdateState {
  return {
    enabled: true,
    status,
    channel: "nightly",
    currentVersion: "0.0.50-nightly.1",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: status === "up-to-date" || status === "idle" ? null : "0.0.50-nightly.2",
    downloadedVersion: status === "downloaded" ? "0.0.50-nightly.2" : null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: status === "downloading" ? 40 : null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: false,
  };
}

describe("MattrUpdateNotice", () => {
  it("shows the update pill only while an update applies, without a list marker", async () => {
    mocks.update = updateState("up-to-date");
    mocks.hasUpdates = false;
    await using screen = await render(
      <SidebarProvider>
        <div className="mfs-notices">
          <MattrUpdateNotice />
        </div>
      </SidebarProvider>,
    );
    const notices = screen.container.querySelector<HTMLElement>(".mfs-notices")!;
    expect(notices.childElementCount).toBe(0);
    expect(getComputedStyle(notices).display).toBe("none");

    for (const status of ["available", "downloading", "downloaded"] as const) {
      await act(() => {
        mocks.update = updateState(status);
        mocks.notify();
      });
      const item = notices.querySelector("li");
      expect(item, status).not.toBeNull();
      expect(getComputedStyle(item!).listStyleType).toBe("none");
    }

    await act(() => {
      mocks.update = updateState("idle");
      mocks.hasUpdates = true;
      mocks.notify();
    });
    expect(notices.querySelector("li")).not.toBeNull();

    await act(() => {
      mocks.update = updateState("up-to-date");
      mocks.hasUpdates = false;
      mocks.notify();
    });
    expect(notices.childElementCount).toBe(0);
  });
});
