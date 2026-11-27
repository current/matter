import { describe, expect, it, vi } from "vite-plus/test";

import { shouldShowMatterComposerContextStrip } from "./components/chat/MatterComposerParts.matter";
import {
  DEFAULT_MATTER_GOOEY_SEND,
  MATTER_GOOEY_SEND_STORAGE_KEY,
  readMatterGooeySend,
  writeMatterGooeySend,
} from "./matterGooeySend";

describe("matterGooeySend storage", () => {
  it("defaults to enabled and persists toggles in localStorage", () => {
    expect(DEFAULT_MATTER_GOOEY_SEND).toBe(true);
    expect(readMatterGooeySend()).toBe(true);

    writeMatterGooeySend(false);
    expect(readMatterGooeySend()).toBe(false);

    writeMatterGooeySend(true);
    expect(readMatterGooeySend()).toBe(true);
  });

  it("falls back to the default on invalid stored data", () => {
    using consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalWindow = globalThis.window;
    const store = new Map<string, string>([[MATTER_GOOEY_SEND_STORAGE_KEY, '"not-a-boolean"']]);
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
      expect(readMatterGooeySend()).toBe(true);
      expect(consoleError).toHaveBeenCalled();
    } finally {
      Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: originalWindow,
      });
    }
  });
});

describe("shouldShowMatterComposerContextStrip", () => {
  const base = {
    embedded: false,
    hasActiveProject: true,
    isScratchProject: false,
    isDraftHeroState: false,
    showProviderSubagentBar: false,
    persistInActiveThreads: true,
    isGitRepo: true,
    showEnvironmentIndicator: false,
    shelfStyle: false,
  };

  it("shows the under-tray in both new-chat drafts and active threads for real projects by default", () => {
    expect(shouldShowMatterComposerContextStrip({ ...base, isDraftHeroState: true })).toBe(true);
    expect(shouldShowMatterComposerContextStrip({ ...base, isDraftHeroState: false })).toBe(true);
    expect(
      shouldShowMatterComposerContextStrip({ ...base, isDraftHeroState: false, isGitRepo: false }),
    ).toBe(true);
  });

  it("hides the under-tray in active threads when Keep context strip is turned off", () => {
    expect(
      shouldShowMatterComposerContextStrip({
        ...base,
        isDraftHeroState: false,
        persistInActiveThreads: false,
      }),
    ).toBe(false);
    expect(
      shouldShowMatterComposerContextStrip({
        ...base,
        isDraftHeroState: true,
        persistInActiveThreads: false,
      }),
    ).toBe(true);
  });

  it("keeps the under-tray in active threads under the Shelf style, which is drawn around it", () => {
    const off = { ...base, isDraftHeroState: false, persistInActiveThreads: false };
    expect(shouldShowMatterComposerContextStrip({ ...off, shelfStyle: true })).toBe(true);
    expect(
      shouldShowMatterComposerContextStrip({ ...off, shelfStyle: true, hasActiveProject: false }),
    ).toBe(false);
  });

  it("keeps the strip for scratch drafts and collapses it cleanly without a real active project", () => {
    expect(
      shouldShowMatterComposerContextStrip({
        ...base,
        isScratchProject: true,
        isDraftHeroState: true,
        isGitRepo: false,
      }),
    ).toBe(true);
    expect(
      shouldShowMatterComposerContextStrip({
        ...base,
        isScratchProject: true,
        isDraftHeroState: false,
        isGitRepo: false,
      }),
    ).toBe(false);
    expect(shouldShowMatterComposerContextStrip({ ...base, hasActiveProject: false })).toBe(false);
    expect(shouldShowMatterComposerContextStrip({ ...base, embedded: true })).toBe(false);
    expect(shouldShowMatterComposerContextStrip({ ...base, showProviderSubagentBar: true })).toBe(
      false,
    );
  });
});
