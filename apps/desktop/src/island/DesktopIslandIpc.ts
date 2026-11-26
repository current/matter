import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopIsland from "./DesktopIsland.ts";
import type { IslandSettings, IslandSnapshot } from "../../../../matter/island/types.ts";

const ISLAND_SYNC_SNAPSHOT_CHANNEL = "desktop:island-sync-snapshot";
const ISLAND_UPDATE_SETTINGS_CHANNEL = "desktop:island-update-settings";
const ISLAND_OPEN_PANEL_CHANNEL = "desktop:island-open-panel";
const ISLAND_CLOSE_PANEL_CHANNEL = "desktop:island-close-panel";

const syncSnapshot = DesktopIpc.makeIpcMethod({
  channel: ISLAND_SYNC_SNAPSHOT_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: (raw, event) =>
    DesktopIsland.DesktopIsland.pipe(
      Effect.flatMap((island) => island.syncSnapshot(raw as IslandSnapshot, event?.sender.id)),
    ),
});

const updateSettings = DesktopIpc.makeIpcMethod({
  channel: ISLAND_UPDATE_SETTINGS_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: (raw) =>
    DesktopIsland.DesktopIsland.pipe(
      Effect.flatMap((island) => island.updateSettings(raw as IslandSettings)),
    ),
});

const openPanel = DesktopIpc.makeIpcMethod({
  channel: ISLAND_OPEN_PANEL_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: (raw) =>
    DesktopIsland.DesktopIsland.pipe(
      Effect.flatMap((island) =>
        island.openPanel(
          typeof raw === "object" && raw !== null
            ? (raw as { readonly startVoice?: boolean })
            : undefined,
        ),
      ),
    ),
});

const closePanel = DesktopIpc.makeIpcMethod({
  channel: ISLAND_CLOSE_PANEL_CHANNEL,
  payload: Schema.Unknown,
  result: Schema.Void,
  handler: () => DesktopIsland.DesktopIsland.pipe(Effect.flatMap((island) => island.closePanel())),
});

export const installDesktopIslandIpc = Effect.fn("desktop.ipc.installIsland")(function* () {
  const ipc = yield* DesktopIpc.DesktopIpc;
  yield* ipc.handle(syncSnapshot);
  yield* ipc.handle(updateSettings);
  yield* ipc.handle(openPanel);
  yield* ipc.handle(closePanel);
});
