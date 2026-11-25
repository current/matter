import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const { configure, dispatchEvents, reportError } = vi.hoisted(() => ({
  configure: vi.fn(),
  dispatchEvents: vi.fn(async () => undefined),
  reportError: vi.fn(),
}));

vi.mock("expo-constants", () => ({
  default: {
    expoConfig: {
      extra: {
        appVariant: "production",
        relay: { url: "https://relay.t3.codes" },
      },
    },
  },
}));

vi.mock("expo-observe", () => ({
  Observe: {
    configure,
    dispatchEvents,
    reportError,
  },
}));

afterEach(() => {
  configure.mockClear();
  dispatchEvents.mockClear();
  reportError.mockClear();
  vi.unstubAllGlobals();
});

describe("observe", () => {
  it("forces crashReportingAvailable off, disables Observe dispatching, and skips Hermes rejection tracking", async () => {
    vi.resetModules();
    const enablePromiseRejectionTracker = vi.fn();
    vi.stubGlobal("__DEV__", false);
    vi.stubGlobal("HermesInternal", { enablePromiseRejectionTracker });

    const observe = await import("./observe");

    expect(observe.crashReportingAvailable).toBe(false);
    expect(enablePromiseRejectionTracker).not.toHaveBeenCalled();
    expect(dispatchEvents).not.toHaveBeenCalled();
    expect(configure).toHaveBeenCalledWith({
      dispatchingEnabled: false,
      environment: "production",
    });

    configure.mockClear();
    await observe.setCrashReportsEnabled(true);
    expect(dispatchEvents).not.toHaveBeenCalled();
    expect(configure).toHaveBeenCalledWith({
      dispatchingEnabled: false,
      environment: "production",
    });
  });
});
