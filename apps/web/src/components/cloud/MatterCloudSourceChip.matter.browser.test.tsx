import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const shells = vi.hoisted(() => new Map<string, { title: string }>());

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "local") as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useQuietThreadShell: ((ref: { threadId: string } | null) =>
    ref === null ? null : (shells.get(ref.threadId) ?? null)) as never,
}));

import "../../index.css";
import { render } from "../../../test/render";
import { MatterCloudSourceChip } from "./MatterCloudSourceChip.matter";

const tracked = (sourceThreadId: string | null) => ({
  tracked: {
    sourceThreadId: sourceThreadId === null ? null : ThreadId.make(sourceThreadId),
  } as never,
});

describe("MatterCloudSourceChip", () => {
  it("links a cloud run back to the chat that started it", async () => {
    shells.set("chat-1", { title: "Port the composer" });
    await using _screen = await render(<MatterCloudSourceChip session={tracked("chat-1")} />);
    const chip = page.getByRole("link", { name: "Started from Port the composer" });
    await expect.element(chip).toHaveAttribute("href", "/local/chat-1");
    await expect.element(page.getByText("Port the composer")).toBeVisible();
    await expect.element(chip).toHaveTextContent("From Port the composer");
    shells.clear();
  });

  it("shows nothing for a session no chat started, or whose chat is gone", async () => {
    await using screen = await render(
      <>
        <MatterCloudSourceChip session={tracked(null)} />
        <MatterCloudSourceChip session={tracked("deleted")} />
        <MatterCloudSourceChip session={null} />
      </>,
    );
    expect(screen.container.querySelector("[data-matter-cloud-source]")).toBeNull();
  });
});
