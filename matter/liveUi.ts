// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - Runs inside Electron's protocol handler, outside Effect.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

// Written by matter/live-ui.mjs while it runs. The installed app serves its UI from that Vite
// server instead of its bundled files, so web changes hot-reload without restarting chats.
export const MATTER_LIVE_UI_FILE = NodePath.join(NodeOS.homedir(), ".antimatter", "live-ui.json");

let liveUiOrigin: URL | undefined;

function isDocumentRequest(request: Request): boolean {
  if (request.method !== "GET") return false;
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") && NodePath.extname(new URL(request.url).pathname) === "";
}

async function probeLiveUiOrigin(): Promise<URL | undefined> {
  try {
    const { url } = JSON.parse(await NodeFSP.readFile(MATTER_LIVE_UI_FILE, "utf8")) as {
      url?: unknown;
    };
    if (typeof url !== "string") return undefined;
    const origin = new URL(url);
    // Loopback only: whatever answers here gets the full desktop bridge.
    if (origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") return undefined;
    const response = await fetch(new URL("/@vite/client", origin), {
      signal: AbortSignal.timeout(750),
    });
    return response.ok ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Picks the UI source on each page load and keeps it for that page's other requests, so a reload
 * switches to the live server once it runs and back to the bundled UI once it stops.
 */
export async function resolveMatterLiveUiOrigin(request: Request): Promise<URL | undefined> {
  if (isDocumentRequest(request)) {
    liveUiOrigin = await probeLiveUiOrigin();
  }
  return liveUiOrigin;
}
