import { describe, expect, it, vi } from "vite-plus/test";

import { shouldShowMattrComposerContextStrip } from "./components/chat/MattrComposerParts.mattr";
import {
  DEFAULT_MATTR_GOOEY_SEND,
  MATTR_GOOEY_SEND_STORAGE_KEY,
  readMattrGooeySend,
  writeMattrGooeySend,
} from "./mattrGooeySend";

describe("mattrGooeySend storage", () => {
  it("defaults to enabled and persists toggles in localStorage", () => {
    expect(DEFAULT_MATTR_GOOEY_SEND).toBe(true);
    expect(readMattrGooeySend()).toBe(true);

    writeMattrGooeySend(false);
    expect(readMattrGooeySend()).toBe(false);

    writeMattrGooeySend(true);
    expect(readMattrGooeySend()).toBe(true);
  });

  it("falls back to the default on invalid stored data", () => {
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalWindow = globalThis.window;
    const store = new Map<string, string>([[MATTR_GOOEY_SEND_STORAGE_KEY, '"not-a-boolean"']]);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => store.set(key, value),
          removeItem: (key: string) => store.delete(key),
        },
        dispatchEvent: () => true,
      },
    });
    try {
      expect(readMattrGooeySend()).toBe(true);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});

describe("shouldShowMattrComposerContextStrip", () => {
  const base = {
    embedded: false,
    hasActiveProject: true,
    isScratchProject: false,
    isDraftHeroState: false,
    showProviderSubagentBar: false,
    persistInActiveThreads: true,
    isGitRepo: true,
    showEnvironmentIndicator: false,
  };

  it("shows the under-tray in both new-chat drafts and active threads for real projects by default", () => {
    expect(shouldShowMattrComposerContextStrip({ ...base, isDraftHeroState: true })).toBe(true);
    expect(shouldShowMattrComposerContextStrip({ ...base, isDraftHeroState: false })).toBe(true);
    expect(
      shouldShowMattrComposerContextStrip({ ...base, isDraftHeroState: false, isGitRepo: false }),
    ).toBe(true);
  });

  it("hides the under-tray in active threads when Keep context strip is turned off", () => {
    expect(
      shouldShowMattrComposerContextStrip({
        ...base,
        isDraftHeroState: false,
        persistInActiveThreads: false,
      }),
    ).toBe(false);
    expect(
      shouldShowMattrComposerContextStrip({
        ...base,
        isDraftHeroState: true,
        persistInActiveThreads: false,
      }),
    ).toBe(true);
  });

  it("keeps the strip for scratch drafts and collapses it cleanly without a real active project", () => {
    expect(
      shouldShowMattrComposerContextStrip({
        ...base,
        isScratchProject: true,
        isDraftHeroState: true,
        isGitRepo: false,
      }),
    ).toBe(true);
    expect(
      shouldShowMattrComposerContextStrip({
        ...base,
        isScratchProject: true,
        isDraftHeroState: false,
        isGitRepo: false,
      }),
    ).toBe(false);
    expect(shouldShowMattrComposerContextStrip({ ...base, hasActiveProject: false })).toBe(false);
    expect(shouldShowMattrComposerContextStrip({ ...base, embedded: true })).toBe(false);
    expect(shouldShowMattrComposerContextStrip({ ...base, showProviderSubagentBar: true })).toBe(
      false,
    );
  });
});
