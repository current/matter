import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { VoiceThreadScope } from "./voiceContextLogic";
import type { VoiceModeDeps } from "./voiceModeSession";

const harness = vi.hoisted(() => ({
  capturedDeps: null as VoiceModeDeps | null,
  readContextCalls: [] as Array<VoiceThreadScope | null>,
  pickConnectionCalls: [] as Array<string | null>,
  watchScopeCalls: [] as Array<VoiceThreadScope | null>,
}));

type Children = { children?: ReactNode };

vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  useWindowDimensions: () => ({ width: 390, height: 844 }),
  KeyboardAvoidingView: ({ children }: Children) => <div>{children}</div>,
  View: ({ children }: Children) => <div>{children}</div>,
  ScrollView: ({ children }: Children) => <div>{children}</div>,
  TextInput: (props: { placeholder?: string }) => <input placeholder={props.placeholder} />,
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
      aria-label={accessibilityLabel}
      disabled={disabled}
      onClick={() => {
        if (!disabled) onPress?.();
      }}
    >
      {children}
    </button>
  ),
}));
vi.mock("react-native-reanimated", () => ({
  makeMutable: (value: number) => ({ value, set: () => {} }),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 44, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: vi.fn() }),
}));
vi.mock("expo-haptics", () => ({
  ImpactFeedbackStyle: { Light: "light" },
  impactAsync: vi.fn(async () => {}),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: Children) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <span data-symbol={name} />,
}));
vi.mock("../../lib/matterAudioCues", () => ({
  playMobileAudioCue: vi.fn(),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => null },
}));
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: {},
}));
vi.mock("../../components/ui/useAndroidControlSizing", () => ({
  useAndroidControlSizing: () => ({ scale: 1, smallIconSize: 16 }),
}));
vi.mock("../../state/entities", () => ({
  useVisibleThreadShells: () => [
    {
      environmentId: "env-1",
      id: "thread-9",
      title: "Matter setup check",
    },
  ],
}));
vi.mock("../layout/useOpenWorkspaceDetail", () => ({
  useOpenWorkspaceDetail: () => vi.fn(),
}));
vi.mock("./SiriWaveMobile", () => ({
  SiriWaveMobile: () => <div data-testid="siri-wave-mobile" />,
}));
vi.mock("./nativeVoiceAudio", () => ({
  NativeVoiceAudio: vi.fn(),
}));
vi.mock("./voiceAssistantApi", () => ({
  createVoiceAssistantApi: vi.fn(() => ({})),
}));
vi.mock("./mobileVoiceContext", () => ({
  executeVoiceClientAction: vi.fn(async () => {}),
  pickVoiceConnection: vi.fn((envId: string | null = null) => {
    harness.pickConnectionCalls.push(envId);
    return null;
  }),
  readVoiceWorkspaceContext: vi.fn((scope: VoiceThreadScope | null = null) => {
    harness.readContextCalls.push(scope);
    return {
      activeEnvironmentId: scope?.environmentId ?? null,
      activeThreadId: scope?.threadId ?? null,
      activeRoute: "MatterVoiceMode",
      mainWindowFocused: true,
      composerFocused: false,
      projects: [],
      threads: [],
      pendingApprovals: [],
      pendingQuestions: [],
    };
  }),
  watchVoiceWorkspace: vi.fn((_onChange: () => void, scope: VoiceThreadScope | null = null) => {
    harness.watchScopeCalls.push(scope);
    return () => {};
  }),
}));
vi.mock("./voiceModeSession", () => {
  const snapshot = {
    phase: "listening" as const,
    handsFree: true,
    muted: false,
    turns: [],
    error: null,
    pendingApprovals: [],
    liveTranscript: null,
  };
  return {
    VoiceModeSession: class {
      constructor(deps: VoiceModeDeps) {
        harness.capturedDeps = deps;
      }
      subscribe = () => () => {};
      getSnapshot = () => snapshot;
      start = () => {
        harness.capturedDeps?.watchWorkspace(() => {});
        harness.capturedDeps?.readContext();
        harness.capturedDeps?.getApi();
      };
      stop = async () => {};
      setHandsFree = () => {};
      setMuted = () => {};
      tapOrb = () => {};
      sendText = () => {};
      respondToApproval = async () => {};
    },
  };
});

import { ComposerVoiceModeButton } from "./ComposerVoiceModeButton";
import { MatterVoiceModeScreen } from "./MatterVoiceModeScreen";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.capturedDeps = null;
  harness.readContextCalls = [];
  harness.pickConnectionCalls = [];
  harness.watchScopeCalls = [];
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe("ComposerVoiceModeButton (mobile)", () => {
  it("renders waveform icon button and fires onPress unless disabled", () => {
    const onPress = vi.fn();
    act(() => {
      root.render(<ComposerVoiceModeButton onPress={onPress} />);
    });

    const button = container.querySelector(
      'button[aria-label="Start voice mode"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(container.querySelector('[data-symbol="waveform"]')).not.toBeNull();

    act(() => {
      button.click();
    });
    expect(onPress).toHaveBeenCalledTimes(1);

    act(() => {
      root.render(<ComposerVoiceModeButton disabled onPress={onPress} />);
    });
    act(() => {
      (
        container.querySelector('button[aria-label="Start voice mode"]') as HTMLButtonElement
      ).click();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
  });
});

describe("MatterVoiceModeScreen thread scoping", () => {
  it("pre-scopes to the launched thread, reads thread-scoped context, and toggles to All workspace and back", () => {
    act(() => {
      root.render(
        <MatterVoiceModeScreen
          route={{
            params: {
              environmentId: "env-1",
              threadId: "thread-9",
              threadTitle: "Fallback title",
            },
          }}
        />,
      );
    });

    // Live thread shell title takes precedence in the header pill.
    expect(container.textContent).toContain("Matter setup check");
    expect(harness.readContextCalls[0]).toEqual({
      environmentId: "env-1",
      threadId: "thread-9",
      title: "Fallback title",
    });
    expect(harness.pickConnectionCalls[0]).toBe("env-1");
    expect(harness.watchScopeCalls[0]).toEqual({
      environmentId: "env-1",
      threadId: "thread-9",
      title: "Fallback title",
    });

    const switchBtn = container.querySelector(
      'button[aria-label="Switch to all workspace"]',
    ) as HTMLButtonElement;
    expect(switchBtn).not.toBeNull();

    act(() => {
      switchBtn.click();
    });

    // Subsequent turns read unscoped workspace context.
    harness.capturedDeps?.readContext();
    expect(harness.readContextCalls.at(-1)).toBeNull();

    const refocusBtn = container.querySelector(
      'button[aria-label="Focus Matter setup check"]',
    ) as HTMLButtonElement;
    expect(refocusBtn).not.toBeNull();

    act(() => {
      refocusBtn.click();
    });
    harness.capturedDeps?.readContext();
    expect(harness.readContextCalls.at(-1)).toEqual({
      environmentId: "env-1",
      threadId: "thread-9",
      title: "Fallback title",
    });
  });

  it("stays unscoped when opened globally without route params", () => {
    act(() => {
      root.render(<MatterVoiceModeScreen />);
    });

    expect(container.querySelector('button[aria-label="Switch to all workspace"]')).toBeNull();
    expect(harness.readContextCalls[0]).toBeNull();
    expect(harness.pickConnectionCalls[0]).toBeNull();
  });
});
