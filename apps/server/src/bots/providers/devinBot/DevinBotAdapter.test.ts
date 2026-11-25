import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { BotEvent } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as NetAddress from "effect/net/NetAddress";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as ServerConfig from "../../../config.ts";
import * as AddonConfigService from "../../AddonConfigService.ts";
import * as BotsPlatformService from "../../BotsPlatformService.ts";
import * as DevinBotAdapter from "./DevinBotAdapter.ts";

const hex = (digit: string) => digit.repeat(32);
const ORG = `org-${hex("0")}`;
const BOT = `bot-${hex("a")}`;
const SESSION = `devin-${hex("b")}`;
const CHILD = hex("c");
const BOARD = `board-${hex("d")}`;
const DECISION = `ticket-${hex("e")}`;
const APPROVAL = `ticket-${hex("f")}`;

const INFO_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.exafunction.windsurf</string>
  <key>CFBundleShortVersionString</key><string>3.0.0</string>
</dict></plist>`;

const layer = BotsPlatformService.layer.pipe(
  Layer.provideMerge(AddonConfigService.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-devin-adapter-" })),
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeHttpServer.layerTest),
);

interface Message {
  readonly eventId: string;
  readonly source: "user" | "devin";
  readonly text: string;
  readonly createdAt: number;
  readonly origin: string | null;
  readonly fromAgent: boolean;
}

interface Ticket {
  readonly ticketId: string;
  readonly title: string;
  readonly summary: string;
  readonly details: string | null;
  readonly cardType: string;
  readonly options: ReadonlyArray<string>;
  readonly buttons: ReadonlyArray<string>;
  readonly createdAt: string;
}

const message = (id: number, source: Message["source"], text: string): Message => ({
  eventId: `event-${id}`,
  source,
  text,
  createdAt: 1_700_000_000 + id,
  origin: "web",
  fromAgent: false,
});

/** A loopback stand-in for Devin.app's DevTools endpoint and the bridge's renderer replies. */
const startMockDevin = Effect.gen(function* () {
  const state = {
    jsonRequests: 0,
    expressions: [] as Array<string>,
    sent: [] as Array<{ readonly devinId: string | null; readonly text: string | null }>,
    slept: [] as Array<string | null>,
    resolved: [] as Array<Record<string, string | null>>,
    firstPage: [message(1, "user", "Plan the launch"), message(2, "devin", "Drafting it now.")],
    secondPage: [message(3, "devin", "Here's the plan.")],
    tickets: [
      {
        ticketId: DECISION,
        title: "Pick a launch day",
        summary: "Which day should we launch?",
        details: "Tuesday has lower traffic.",
        cardType: "decision",
        options: ["Tuesday", "Thursday"],
        buttons: [],
        createdAt: "2026-11-20T10:00:00.000Z",
      },
      {
        ticketId: APPROVAL,
        title: "Merge PR",
        summary: "Approve merging the launch PR?",
        details: null,
        cardType: "approval",
        options: [],
        buttons: [],
        createdAt: "2026-11-20T11:00:00.000Z",
      },
    ] as Array<Ticket>,
    socketClosed: yield* Deferred.make<void>(),
  };
  const portRef = { current: 0 };

  const answer = (expression: string): unknown => {
    state.expressions.push(expression);
    const call = /\}\)\(("[a-z]+"), (\{.*\})\)\.catch\(/s.exec(expression);
    if (!call) return { ok: false, reason: "invalid_args" };
    const op = JSON.parse(call[1]!) as string;
    const args = JSON.parse(call[2]!) as Record<string, string | null>;
    switch (op) {
      case "snapshot":
        return {
          ok: true,
          data: {
            orgId: ORG,
            bots: [
              {
                id: BOT,
                name: "Launch Bot",
                avatarUrl: null,
                session: {
                  devinId: SESSION,
                  status: "running",
                  statusEnum: "working",
                  isUnread: true,
                  needsAttention: false,
                },
              },
            ],
            inboxes: [{ botId: BOT, boardId: BOARD, askCount: state.tickets.length }],
          },
        };
      case "children":
        return {
          ok: true,
          data: {
            sessions: [
              {
                devinId: CHILD,
                title: "Write release notes",
                status: "running",
                statusDetail: "waiting_for_user",
                updatedAt: 1_700_000_100,
                archived: false,
              },
            ],
          },
        };
      case "messages":
        // Devin's cursor paging: forward only, and no cursor past the last page.
        return args.after === null
          ? {
              ok: true,
              data: { messages: state.firstPage, endCursor: "cursor-1", hasNextPage: true },
            }
          : { ok: true, data: { messages: state.secondPage, endCursor: null, hasNextPage: false } };
      case "inbox":
        return { ok: true, data: { tickets: state.tickets } };
      case "send":
        state.sent.push({ devinId: args.devinId ?? null, text: args.text ?? null });
        return { ok: true, data: {} };
      case "sleep":
        state.slept.push(args.devinId ?? null);
        return { ok: true, data: {} };
      case "resolve":
        state.resolved.push(args);
        state.tickets = state.tickets.filter((ticket) => ticket.ticketId !== args.ticketId);
        return { ok: true, data: {} };
      default:
        return { ok: false, reason: "invalid_args" };
    }
  };

  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/json",
      Effect.sync(() => {
        state.jsonRequests += 1;
        return HttpServerResponse.text(
          JSON.stringify([
            {
              id: "webview",
              type: "page",
              url: "vscode-webview://abc/index.html",
              webSocketDebuggerUrl: `ws://127.0.0.1:${portRef.current}/devtools/page/webview`,
            },
            {
              id: "workbench",
              type: "page",
              title: "Devin",
              url: "vscode-file://vscode-app/Applications/Devin.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html",
              webSocketDebuggerUrl: `ws://127.0.0.1:${portRef.current}/devtools/page/workbench`,
            },
          ]),
          { contentType: "application/json" },
        );
      }),
    ),
    HttpRouter.add(
      "GET",
      "/devtools/page/workbench",
      Effect.gen(function* () {
        const socket = yield* (yield* HttpServerRequest.HttpServerRequest).upgrade;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const reader = yield* socket.reader;
            const writer = yield* socket.writer;
            const decoder = new TextDecoder();
            while (true) {
              for (const frame of yield* reader.pull) {
                const rpc = JSON.parse(
                  typeof frame === "string" ? frame : decoder.decode(frame),
                ) as { readonly id: number; readonly params: { readonly expression: string } };
                yield* writer.write(
                  JSON.stringify({
                    id: rpc.id,
                    result: { result: { type: "object", value: answer(rpc.params.expression) } },
                  }),
                );
              }
            }
          }),
        ).pipe(
          Effect.ensuring(Deferred.succeed(state.socketClosed, undefined)),
          Effect.ignoreCause,
        );
        return HttpServerResponse.empty();
      }),
    ),
  );
  yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }));
  const server = yield* HttpServer.HttpServer;
  portRef.current = (server.address as NetAddress.InetAddress).port;
  return { state, port: portRef.current };
});

/** A fake `/Applications/Devin.app`, so the test never depends on (or touches) this Mac's app. */
const fakeApp = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "devin-app-" });
  yield* fs.makeDirectory(`${dir}/Contents`, { recursive: true });
  yield* fs.writeFileString(`${dir}/Contents/Info.plist`, INFO_PLIST);
  return dir;
});

const collectEvents = Effect.gen(function* () {
  const platform = yield* BotsPlatformService.BotsPlatformService;
  const queue = yield* Queue.unbounded<BotEvent>();
  yield* platform.events.pipe(
    Stream.runForEach((event) => Queue.offer(queue, event)),
    Effect.forkScoped,
  );
  yield* Effect.yieldNow;
  return Effect.fn("waitForEvent")(function* (predicate: (event: BotEvent) => boolean) {
    while (true) {
      const event = yield* Queue.take(queue);
      if (predicate(event)) return event;
    }
  }, Effect.timeout("15 seconds"));
});

const settle = Effect.gen(function* () {
  for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
});

describe("DevinBotAdapter through BotsPlatformService", () => {
  it.live("opens no CDP connection while the add-on is disabled", () =>
    Effect.gen(function* () {
      const { state, port } = yield* startMockDevin;
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const config = yield* AddonConfigService.AddonConfigService;
      yield* config.updateConfig("devin-bot", { cdpPort: port });
      yield* platform.register(yield* DevinBotAdapter.make({ appPath: yield* fakeApp }));
      yield* collectEvents;
      yield* platform.reconcile;
      yield* settle;

      assert.strictEqual(state.jsonRequests, 0);
      assert.deepStrictEqual(yield* platform.runningProviderIds, []);
      assert.deepStrictEqual(yield* platform.addonStatus("devin-bot"), { kind: "disabled" });
      assert.deepStrictEqual(yield* platform.reconnect("devin-bot"), { kind: "disabled" });
      assert.strictEqual(state.jsonRequests, 0);
      assert.deepStrictEqual(state.expressions, []);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("lists Bots, pages history, sends, cancels, answers requests and disconnects", () =>
    Effect.gen(function* () {
      const { state, port } = yield* startMockDevin;
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const config = yield* AddonConfigService.AddonConfigService;
      yield* config.updateConfig("devin-bot", { cdpPort: port });
      yield* platform.register(
        yield* DevinBotAdapter.make({
          appPath: yield* fakeApp,
          pollIntervals: { idleMs: 500, activeMs: 500 },
        }),
      );
      const waitFor = yield* collectEvents;

      yield* config.setEnabled({ id: "devin-bot", enabled: true });
      yield* waitFor((e) => e.type === "provider-status" && e.status.kind === "connected");
      const changed = yield* waitFor((e) => e.type === "bots-changed");
      assert.strictEqual(changed.type === "bots-changed" && changed.bots[0]?.name, "Launch Bot");

      const [descriptor] = yield* platform.listProviders;
      assert.strictEqual(descriptor?.transport, "local-app-bridge");
      assert.deepStrictEqual(descriptor?.capabilities, DevinBotAdapter.DEVIN_BOT_CAPABILITIES);

      const [bot] = yield* platform.listBots("devin-bot");
      assert.strictEqual(bot?.accountScopeId, ORG);
      assert.strictEqual(bot?.status, "working");
      assert.strictEqual(bot?.unreadCount, 1);
      assert.deepStrictEqual(bot?.avatar, { kind: "icon", icon: "bot" });
      assert.strictEqual(bot?.defaultConversationId, BOT);
      assert.match(bot?.officialAppUrl ?? "", /^devin:\/\/app\/open\//);

      const conversations = yield* platform.listConversations({
        providerId: "devin-bot",
        botId: BOT,
      });
      assert.deepStrictEqual(
        conversations.map((c) => [
          c.conversationId,
          c.kind,
          c.activityState,
          c.parentConversationId,
        ]),
        [
          [BOT, "direct", "working", null],
          [`session:${CHILD}`, "delegated-session", "waiting_for_user", BOT],
        ],
      );

      const newest = yield* platform.getMessages({
        providerId: "devin-bot",
        conversationId: BOT,
        olderCursor: null,
        limit: 2,
      });
      assert.deepStrictEqual(
        newest.messages.map((m) => [m.remoteId, m.role, m.seq]),
        [
          ["event-2", "agent", 1],
          ["event-3", "agent", 2],
        ],
      );
      assert.strictEqual(newest.olderCursor, "idx:1");
      const older = yield* platform.getMessages({
        providerId: "devin-bot",
        conversationId: BOT,
        olderCursor: newest.olderCursor,
        limit: 2,
      });
      assert.deepStrictEqual(
        older.messages.map((m) => [m.remoteId, m.attribution]),
        [["event-1", "user-via-other-client"]],
      );
      assert.strictEqual(older.olderCursor, null);

      // Messaging can wake a suspended cloud session, so it needs the usage confirmation.
      const unconfirmed = yield* platform
        .sendMessage({
          providerId: "devin-bot",
          conversationId: BOT,
          text: "Ship Tuesday",
          clientNonce: "nonce-1",
        })
        .pipe(Effect.flip);
      assert.strictEqual(unconfirmed.code, "usage_confirmation_required");
      assert.deepStrictEqual(state.sent, []);
      const sent = yield* platform.sendMessage({
        providerId: "devin-bot",
        conversationId: BOT,
        text: "Ship Tuesday",
        clientNonce: "nonce-1",
        confirmUsage: true,
      });
      assert.strictEqual(sent.attribution, "user-via-mattr");
      assert.deepStrictEqual(state.sent, [{ devinId: SESSION, text: "Ship Tuesday" }]);

      // A new message on the last page arrives by re-reading that page from its cursor.
      state.secondPage.push(message(4, "user", "Ship Tuesday"));
      const echoed = yield* waitFor(
        (e) => e.type === "message-upserted" && e.message.remoteId === "event-4",
      );
      assert.strictEqual(
        echoed.type === "message-upserted" && echoed.message.clientNonce,
        "nonce-1",
      );

      yield* platform.cancel({ providerId: "devin-bot", conversationId: `session:${CHILD}` });
      assert.deepStrictEqual(state.slept, [CHILD]);

      const pending = yield* platform.listPendingRequests;
      assert.deepStrictEqual(
        pending.map((r) => [r.requestId, r.kind, r.options.map((o) => o.label)]),
        [
          [`${BOARD}:${DECISION}`, "question", ["Tuesday", "Thursday"]],
          [`${BOARD}:${APPROVAL}`, "approval", []],
        ],
      );
      yield* platform.respondToRequest({
        providerId: "devin-bot",
        requestId: `${BOARD}:${DECISION}`,
        response: { kind: "option", optionId: "answer:0" },
      });
      yield* platform.respondToRequest({
        providerId: "devin-bot",
        requestId: `${BOARD}:${APPROVAL}`,
        response: { kind: "decision", decision: "approve" },
      });
      assert.deepStrictEqual(state.resolved, [
        { boardId: BOARD, ticketId: DECISION, action: "answer", option: "Tuesday" },
        { boardId: BOARD, ticketId: APPROVAL, action: "approve", option: null },
      ]);
      assert.deepStrictEqual(yield* platform.listPendingRequests, []);

      // The bridge never asks the renderer for credentials.
      for (const expression of state.expressions) {
        assert.notInclude(expression, "getAccessToken");
        assert.notInclude(expression, "document.cookie");
        assert.notInclude(expression, "localStorage");
      }

      yield* config.setEnabled({ id: "devin-bot", enabled: false });
      yield* waitFor((e) => e.type === "provider-status" && e.status.kind === "disabled");
      yield* Deferred.await(state.socketClosed).pipe(Effect.timeout("5 seconds"));
      assert.deepStrictEqual(yield* platform.runningProviderIds, []);
      assert.deepStrictEqual(yield* config.getConfig("devin-bot"), { cdpPort: port });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.live("reports a closed debug port and a missing app without touching Devin", () =>
    Effect.gen(function* () {
      const platform = yield* BotsPlatformService.BotsPlatformService;
      const config = yield* AddonConfigService.AddonConfigService;
      const appPath = yield* fakeApp;
      // Port 1 is never a Devin debug port, so the probe is refused at once.
      yield* config.updateConfig("devin-bot", { cdpPort: 1 });
      yield* platform.register(yield* DevinBotAdapter.make({ appPath }));
      yield* config.setEnabled({ id: "devin-bot", enabled: true });

      const unconfigured = yield* platform.reconnect("devin-bot");
      assert.strictEqual(unconfigured?.kind, "enabled_unconfigured");
      assert.strictEqual(unconfigured?.action?.kind, "configure");
      assert.strictEqual(unconfigured?.detail, "Devin isn't reachable on debug port 1.");

      yield* platform.register(yield* DevinBotAdapter.make({ appPath: `${appPath}/missing.app` }));
      const missing = yield* platform.reconnect("devin-bot");
      assert.strictEqual(missing?.kind, "app_unavailable");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
