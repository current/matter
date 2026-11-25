import { assert, describe, it } from "@effect/vitest";

import {
  buildDevinBridgeExpression,
  selectDevinWorkbenchTarget,
  validateDevinLoopbackEndpoint,
  type DevinBridgeOperation,
} from "./devinBotStoreNormalization.ts";

const ORG = `org-${"0".repeat(32)}`;
const SESSION = `devin-${"b".repeat(32)}`;
const BOARD = `board-${"d".repeat(32)}`;
const TICKET = `ticket-${"e".repeat(32)}`;

interface Call {
  readonly method: string;
  readonly path: string;
  readonly options: Record<string, unknown> | undefined;
}

/** A fake Devin renderer: one `.devin-app-root` whose React tree holds the API and auth providers. */
function fakeRenderer(reply: (call: Call) => { status: number; body: unknown }) {
  const calls: Array<Call> = [];
  const request = (method: string) => async (path: string, options?: Record<string, unknown>) => {
    const call = { method, path, options };
    calls.push(call);
    const { status, body } = reply(call);
    return { status, json: async () => body };
  };
  const api = Object.assign(request("get"), { get: request("get"), post: request("post") });
  const authFiber = {
    memoizedProps: {
      value: {
        orgId: ORG,
        isAuthenticated: true,
        changeOrganization: () => undefined,
        getAccessToken: () => {
          throw new Error("the bridge must never read the access token");
        },
      },
    },
    child: null,
    sibling: null,
  };
  const apiFiber = {
    memoizedProps: { value: { invalidateQueries: () => undefined, client: { api } } },
    child: authFiber,
    sibling: null,
  };
  const root = { __reactContainer$test: { stateNode: { current: { child: apiFiber } } } };
  const document = { querySelectorAll: () => [root] };
  const run = (op: DevinBridgeOperation, args: Record<string, string | null> = {}) =>
    new Function("document", `return ${buildDevinBridgeExpression(op, args)}`)(document) as Promise<
      Record<string, unknown>
    >;
  return { calls, run };
}

describe("buildDevinBridgeExpression", () => {
  it("sends through the official v3 messages endpoint", async () => {
    const renderer = fakeRenderer(() => ({ status: 200, body: {} }));
    const result = await renderer.run("send", { devinId: SESSION, text: 'Ship "it"' });
    assert.deepStrictEqual(result, { ok: true, data: {} });
    assert.strictEqual(renderer.calls.length, 1);
    const [call] = renderer.calls;
    assert.strictEqual(call?.method, "post");
    assert.strictEqual(call?.path, `v3/organizations/${ORG}/sessions/${SESSION}/messages`);
    assert.deepStrictEqual(call?.options?.json, { message: 'Ship "it"' });
    assert.strictEqual(call?.options?.throwHttpErrors, false);
  });

  it("resolves inbox tickets and sleeps sessions with Devin's own routes", async () => {
    const renderer = fakeRenderer(() => ({ status: 200, body: {} }));
    await renderer.run("resolve", {
      boardId: BOARD,
      ticketId: TICKET,
      action: "answer",
      option: "Tuesday",
    });
    await renderer.run("resolve", {
      boardId: BOARD,
      ticketId: TICKET,
      action: "approve",
      option: null,
    });
    await renderer.run("sleep", { devinId: SESSION });
    assert.deepStrictEqual(
      renderer.calls.map((call) => [call.method, call.path, call.options?.json]),
      [
        [
          "post",
          `${ORG}/boards/${BOARD}/tickets/${TICKET}/inbox-resolve`,
          { action: "answer", option: "Tuesday" },
        ],
        ["post", `${ORG}/boards/${BOARD}/tickets/${TICKET}/inbox-resolve`, { action: "approve" }],
        ["post", `sessions/${SESSION}/sleep`, undefined],
      ],
    );
  });

  it("maps HTTP failures and keeps only open inbox asks", async () => {
    const failing = fakeRenderer(() => ({ status: 403, body: null }));
    assert.deepStrictEqual(await failing.run("sleep", { devinId: SESSION }), {
      ok: false,
      reason: "forbidden",
      status: 403,
    });

    const inbox = fakeRenderer(() => ({
      status: 200,
      body: {
        tickets: [
          {
            ticket_id: TICKET,
            category: "started",
            inbox: { summary: "Pick one", card: { type: "decision", options: [{ label: "A" }] } },
          },
          {
            ticket_id: "resolved",
            category: "started",
            inbox: { resolution: { action: "answer" } },
          },
          { ticket_id: "done", category: "completed", inbox: {} },
        ],
      },
    }));
    const result = await inbox.run("inbox", { boardId: BOARD });
    const tickets = (result.data as { tickets: Array<Record<string, unknown>> }).tickets;
    assert.deepStrictEqual(
      tickets.map((ticket) => [ticket.ticketId, ticket.cardType, ticket.options]),
      [[TICKET, "decision", ["A"]]],
    );
  });

  it("reports a renderer without the Devin webapp as store_unavailable", async () => {
    const result = (await new Function(
      "document",
      `return ${buildDevinBridgeExpression("snapshot")}`,
    )({ querySelectorAll: () => [] })) as unknown;
    assert.deepStrictEqual(result, { ok: false, reason: "store_unavailable" });
  });
});

describe("Devin CDP endpoint", () => {
  it("accepts only 127.0.0.1", () => {
    assert.isTrue(validateDevinLoopbackEndpoint({ host: "127.0.0.1", port: 9223 }).ok);
    assert.isFalse(validateDevinLoopbackEndpoint({ host: "localhost", port: 9223 }).ok);
    assert.isFalse(validateDevinLoopbackEndpoint({ host: "0.0.0.0", port: 9223 }).ok);
  });

  it("picks the workbench window over webviews and remote sockets", () => {
    const workbench =
      "vscode-file://vscode-app/Applications/Devin.app/Contents/Resources/app/out/vs/code/electron-browser/workbench/workbench.html";
    const selected = selectDevinWorkbenchTarget(
      [
        {
          type: "page",
          url: "vscode-webview://x/index.html",
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/a",
        },
        {
          type: "page",
          url: workbench,
          webSocketDebuggerUrl: "ws://10.0.0.2:9223/devtools/page/b",
        },
        {
          type: "page",
          url: workbench,
          webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/page/c",
        },
      ],
      9223,
    );
    assert.strictEqual(selected?.webSocketDebuggerUrl, "ws://127.0.0.1:9223/devtools/page/c");
  });
});
