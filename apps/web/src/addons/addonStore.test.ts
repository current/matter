import type { AddonEntry, AddonListResponse } from "@t3tools/contracts";
import { MATTER_ADDON_MANIFESTS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  enabledBotProviderAddonIds,
  getAddonStoreState,
  hasLegacyVoiceAssistantPreference,
  isAddonEnabled,
  loadAddons,
  resetAddonStoreForTests,
  setAddonEnabled,
} from "./addonStore";

const config = { baseUrl: "http://server.test", headers: {} };

function serverEntries(enabled: Record<string, boolean>, source = "user" as const) {
  return MATTER_ADDON_MANIFESTS.map((manifest): AddonEntry => ({
    manifest,
    state: {
      id: manifest.id,
      enabled: enabled[manifest.id] ?? false,
      enablementSource: enabled[manifest.id] === undefined ? "default" : source,
      updatedAt: null,
      status: enabled[manifest.id] ? { kind: "connected" } : { kind: "disabled" },
    },
  }));
}

const json = (body: AddonListResponse, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memoryStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => void items.delete(key),
    setItem: (key, value) => void items.set(key, String(value)),
  };
}

describe("addonStore", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStorage();
    vi.stubGlobal("window", { localStorage: storage, dispatchEvent: () => true });
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    resetAddonStoreForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetAddonStoreForTests();
  });

  it("starts every add-on off from manifest defaults", () => {
    const state = getAddonStoreState();
    expect(state.source).toBe("local");
    expect(state.entries.map((entry) => entry.manifest.id)).toEqual(
      MATTER_ADDON_MANIFESTS.map((manifest) => manifest.id),
    );
    expect(state.entries.every((entry) => !entry.state.enabled)).toBe(true);
    expect(isAddonEnabled("grok-bot")).toBe(false);
    expect(enabledBotProviderAddonIds()).toEqual([]);
  });

  it("detects saved Island voice settings as a legacy voice assistant preference", () => {
    expect(hasLegacyVoiceAssistantPreference()).toBe(false);
    storage.setItem("mattr:island:settings:v1", JSON.stringify({ enabled: true }));
    expect(hasLegacyVoiceAssistantPreference()).toBe(false);
    storage.setItem(
      "mattr:island:settings:v1",
      JSON.stringify({ voiceAssistant: { ttsProvider: "openai" } }),
    );
    expect(hasLegacyVoiceAssistantPreference()).toBe(true);
    resetAddonStoreForTests();
    const voice = getAddonStoreState().entries.find(
      (entry) => entry.manifest.id === "voice-assistant",
    );
    expect(voice?.state).toMatchObject({ enabled: true, enablementSource: "migrated" });
  });

  it("applies the server's registry, caches it and lists enabled Bots providers", async () => {
    fetchMock.mockResolvedValueOnce(json({ addons: serverEntries({ "grok-bot": true }) }));
    await loadAddons(config);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://server.test/api/mattr/addons",
      expect.anything(),
    );
    expect(getAddonStoreState().source).toBe("server");
    expect(isAddonEnabled("grok-bot")).toBe(true);
    expect(enabledBotProviderAddonIds()).toEqual(["grok-bot"]);

    resetAddonStoreForTests();
    expect(isAddonEnabled("grok-bot")).toBe(true);
    expect(getAddonStoreState().source).toBe("local");
  });

  it("migrates a legacy voice assistant preference once, as a migration", async () => {
    storage.setItem(
      "mattr:island:settings:v1",
      JSON.stringify({ voiceAssistant: { ttsProvider: "openai" } }),
    );
    fetchMock
      .mockResolvedValueOnce(json({ addons: serverEntries({}) }))
      .mockResolvedValueOnce(
        json({ addons: serverEntries({ "voice-assistant": true }, "migrated" as "user") }),
      );
    await loadAddons(config);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, init] = fetchMock.mock.calls[1]!;
    expect(JSON.parse(String(init?.body))).toEqual({
      id: "voice-assistant",
      enabled: true,
      source: "migrated",
    });
    expect(isAddonEnabled("voice-assistant")).toBe(true);
  });

  it("does not migrate over a choice the server already recorded", async () => {
    storage.setItem(
      "mattr:island:settings:v1",
      JSON.stringify({ voiceAssistant: { ttsProvider: "openai" } }),
    );
    fetchMock.mockResolvedValueOnce(json({ addons: serverEntries({ "voice-assistant": false }) }));
    await loadAddons(config);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(isAddonEnabled("voice-assistant")).toBe(false);
  });

  it("shares one request between concurrent loads", async () => {
    fetchMock.mockResolvedValue(json({ addons: serverEntries({}) }));
    await Promise.all([loadAddons(config), loadAddons(config)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("toggles optimistically and keeps the server's answer", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = setAddonEnabled(config, "grok-bot", true);
    expect(isAddonEnabled("grok-bot")).toBe(true);
    expect(getAddonStoreState().pendingIds).toEqual(["grok-bot"]);
    resolve(json({ addons: serverEntries({ "grok-bot": true }) }));
    await pending;
    expect(getAddonStoreState().pendingIds).toEqual([]);
    expect(getAddonStoreState().source).toBe("server");
    expect(isAddonEnabled("grok-bot")).toBe(true);
  });

  it("reverts the toggle and reports the error when the server refuses", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    );
    await setAddonEnabled(config, "grok-bot", true);
    expect(isAddonEnabled("grok-bot")).toBe(false);
    expect(getAddonStoreState().error).not.toBeNull();
    expect(getAddonStoreState().pendingIds).toEqual([]);
  });
});
