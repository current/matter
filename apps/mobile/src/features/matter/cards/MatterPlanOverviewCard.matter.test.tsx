import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vite-plus/test";

type Children = { children?: ReactNode };

const mocks = vi.hoisted(() => ({
  approvePlan: null as null | ((planMarkdown: string) => Promise<unknown>),
  canWrite: true,
  writeFile: vi.fn(async () => AsyncResult.success({ relativePath: "plan.md" })),
  dialogAlert: vi.fn(),
  dialogPrompt: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: Children & {
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) => (
    <button
      type="button"
      disabled={disabled}
      aria-label={accessibilityLabel}
      onClick={disabled ? undefined : onPress}
    >
      {children}
    </button>
  ),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => mocks.canWrite,
}));
vi.mock("../../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-symbol={name} />,
}));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    onPress,
  }: {
    label: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../../components/ui/Dialog", () => ({
  alert: (...args: unknown[]) => mocks.dialogAlert(...args),
  prompt: (...args: unknown[]) => mocks.dialogPrompt(...args),
}));
vi.mock("../../../components/ui/Sheet", () => ({
  Sheet: ({
    title,
    children,
    onClose,
  }: {
    title: string;
    children: ReactNode;
    onClose: () => void;
  }) => (
    <div data-sheet-title={title}>
      <button type="button" aria-label="Close sheet" onClick={onClose} />
      {children}
    </div>
  ),
}));
vi.mock("../../../lib/clock", () => ({
  useDeadlinePassed: () => false,
}));
vi.mock("../../../lib/copyTextWithHaptic", () => ({
  tryCopyTextWithHaptic: vi.fn(async () => true),
}));
vi.mock("../../../state/projects", () => ({
  projectEnvironment: {
    writeFile: {
      permissionAtom: () => ({}),
    },
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => mocks.writeFile,
}));
vi.mock("../../threads/CopyTextButton", () => ({
  CopyTextButton: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
    <button type="button" aria-label={accessibilityLabel} />
  ),
}));
vi.mock("./useMatterPlanApproval.matter", () => ({
  useMatterProposedPlanApprove: () => mocks.approvePlan,
}));

import { MatterPlanOverviewCard } from "./MatterPlanOverviewCard.matter";

const SAMPLE_PLAN = [
  "# Session auth migration",
  "",
  "Switch from bearer tokens to HTTP-only cookies safely.",
  "",
  "## To-dos",
  "- [x] Create sessions table",
  "- [ ] Add auth middleware",
  "- [ ] Migrate login route",
  "- [ ] Remove legacy tokens",
].join("\n");

function renderPlanCard(markdown = SAMPLE_PLAN) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <MatterPlanOverviewCard
        environmentId={"env-1" as EnvironmentId}
        workspaceRoot="/repo"
        markdown={markdown}
        renderMarkdown={(text) => <pre data-markdown>{text}</pre>}
      />,
    ),
  );
  return {
    container,
    [Symbol.dispose]() {
      act(() => root.unmount());
    },
  };
}

describe("MatterPlanOverviewCard", () => {
  it("renders title, summary, collapsed to-dos with expand toggle, and View Plan sheet", async () => {
    mocks.approvePlan = null;
    using screen = renderPlanCard();

    expect(screen.container.textContent).toContain("Plan Overview");
    expect(screen.container.textContent).toContain("Session auth migration");
    expect(screen.container.textContent).toContain(
      "Switch from bearer tokens to HTTP-only cookies safely.",
    );
    expect(screen.container.textContent).toContain("To-dos");
    expect(screen.container.textContent).toContain("Create sessions table");
    expect(screen.container.textContent).toContain("Migrate login route");
    expect(screen.container.textContent).not.toContain("Remove legacy tokens");
    expect(screen.container.textContent).toContain("1 more");
    expect(screen.container.querySelector('button[aria-label="Approve"]')).toBeNull();

    const moreButton = [...screen.container.querySelectorAll("button")].find((button) =>
      button.textContent?.includes("1 more"),
    );
    await act(async () => moreButton?.click());
    expect(screen.container.textContent).toContain("Remove legacy tokens");
    expect(screen.container.textContent).toContain("Show less");

    const viewPlanButton = screen.container.querySelector(
      'button[aria-label="View Plan"]',
    ) as HTMLButtonElement | null;
    await act(async () => viewPlanButton?.click());

    const sheet = screen.container.querySelector('[data-sheet-title="Session auth migration"]');
    expect(sheet).not.toBeNull();
    expect(sheet?.querySelector("[data-markdown]")?.textContent).toContain("Remove legacy tokens");
  });

  it("shows Approve when actionable and triggers approval with the plan markdown", async () => {
    const approve = vi.fn(async () => AsyncResult.success(undefined));
    mocks.approvePlan = approve;
    using screen = renderPlanCard();

    const approveButton = screen.container.querySelector(
      'button[aria-label="Approve"]',
    ) as HTMLButtonElement | null;
    expect(approveButton).not.toBeNull();
    await act(async () => approveButton?.click());
    expect(approve).toHaveBeenCalledWith(SAMPLE_PLAN);
  });
});
