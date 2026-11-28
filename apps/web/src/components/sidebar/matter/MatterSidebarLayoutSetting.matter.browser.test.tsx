import { EnvironmentId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import "../../../index.css";
import {
  MATTER_SIDEBAR_LAYOUT_STORAGE_KEY,
  useMatterHiddenUsageMeters,
} from "./matterSidebarStore";

const PRIMARY = EnvironmentId.make("local");

const provider = (instanceId: string, driver: string, usedPercent: number) =>
  ({
    instanceId,
    driver,
    displayName: instanceId,
    enabled: true,
    usageLimits: {
      checkedAt: "2026-03-10T15:00:00.000Z",
      windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent }],
    },
  }) as unknown as ServerProvider;

vi.mock(import("../../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => PRIMARY,
  useEnvironmentProviders: () =>
    new Map([
      [
        PRIMARY,
        [
          provider("claudeAgent", "claudeAgent", 68),
          provider("codex-max", "codex", 10),
          provider("antigravity", "antigravity", 90),
        ],
      ],
    ]),
}));

import { MatterSidebarLayoutSetting } from "./MatterSidebarLayoutSetting";

function HiddenMeters() {
  const [hidden] = useMatterHiddenUsageMeters();
  return <output data-testid="hidden">{hidden.join(",")}</output>;
}

describe("Usage meters setting", () => {
  it("hides and shows a provider's meter on this device, keeping at least one", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(MATTER_SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify("timeline"));
    await using _screen = await render(
      <>
        <MatterSidebarLayoutSetting />
        <HiddenMeters />
      </>,
    );
    const codex = page.getByRole("checkbox", { name: /^Codex/ });
    await expect.element(codex).toBeChecked();

    await codex.click();
    await expect.element(codex).not.toBeChecked();
    await expect.element(page.getByTestId("hidden")).toHaveTextContent("codex");

    await page.getByRole("checkbox", { name: /^Antigravity/ }).click();
    await expect.element(page.getByRole("checkbox", { name: /^Claude/ })).toBeDisabled();

    await page.getByRole("button", { name: "Show every usage meter" }).click();
    await expect.element(codex).toBeChecked();
    await expect.element(page.getByTestId("hidden")).toHaveTextContent("");
    window.localStorage.clear();
  });

  it("is offered only for layouts with usage meters", async () => {
    window.localStorage.clear();
    window.localStorage.setItem(MATTER_SIDEBAR_LAYOUT_STORAGE_KEY, JSON.stringify("classic"));
    await using _screen = await render(<MatterSidebarLayoutSetting />);
    await expect.element(page.getByText("Sidebar layout")).toBeVisible();
    await expect.element(page.getByText("Usage meters")).not.toBeInTheDocument();
    window.localStorage.clear();
  });
});
