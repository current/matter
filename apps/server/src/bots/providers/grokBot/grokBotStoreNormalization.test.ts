// @effect-diagnostics globalTimers:off extendsNativeError:off -- This fakes Grok Bot's browser renderer, which uses plain timers and throws plain errors.
import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import {
  buildCancelRunExpression,
  buildDiscoverBotsExpression,
  buildListMessagesExpression,
  buildRespondToWidgetExpression,
  buildSendMessageExpression,
  normalizeGrokBotTranscript,
} from "./grokBotStoreNormalization.ts";

type Entry = Record<string, unknown>;
type Envelope = {
  readonly ok: boolean;
  readonly reason?: string;
  readonly code?: string | null;
  readonly data?: Record<string, unknown>;
};

/** Timers run at most 20 ms so the renderer-side waits finish quickly under test. */
const fastSetTimeout = (callback: () => void, ms: number) => setTimeout(callback, Math.min(ms, 20));

async function run(expression: string, document: unknown): Promise<Envelope> {
  const context = NodeVM.createContext({
    document,
    setTimeout: fastSetTimeout,
    clearTimeout,
    Promise,
    Object,
    Array,
    Boolean,
    Number,
    String,
    Math,
    Error,
    RegExp,
  });
  return (await NodeVM.runInContext(expression, context)) as Envelope;
}

/** Fails like Grok Bot's failed sends do: an error carrying `failure.code`. */
class GrokSendFailure extends Error {
  readonly failure: { readonly code: string };
  constructor(code: string) {
    super(code);
    this.failure = { code };
  }
}

interface TranscriptState {
  entries: Entry[];
  loadState: string;
  failure: unknown;
  hasOlder: boolean;
}

/**
 * Grok Bot 1.3.0's renderer as Matter sees it: a React root whose fibers read the app's store
 * registry from context. Shapes follow a live capture from Grok Bot 1.3.0.
 */
function makeGrokRenderer(options: {
  readonly rows: ReadonlyArray<Entry>;
  readonly transcripts?: Record<string, Partial<TranscriptState>>;
  readonly olderEntries?: Record<string, Entry[]>;
  readonly unloaded?: Record<string, Entry[]>;
  readonly sendPrompt?: (input: {
    readonly agentId: string;
    readonly prompt: string;
    readonly onNonceAssigned?: (event: { readonly nonce: string }) => void;
    readonly onJournaled?: (event: unknown) => void;
    readonly onDispatched?: (event: { readonly agentId: string; readonly nonce: string }) => void;
  }) => Promise<void>;
  readonly interruptAgentRun?: (input: { agentId: string; sessionId?: string }) => Promise<unknown>;
  readonly respondToWidget?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly exposeStores?: boolean;
}) {
  const calls = {
    select: [] as string[],
    load: [] as Array<{ agentId: string; options: unknown }>,
    loadOlder: [] as string[],
    composerSubmit: [] as unknown[],
    noteSent: [] as string[],
    egressClaims: 0,
  };
  const transcripts = new Map<string, TranscriptState>();
  const listeners = new Map<string, Set<() => void>>();
  const stateFor = (agentId: string) => {
    let state = transcripts.get(agentId);
    if (!state) {
      state = {
        entries: [],
        loadState: "idle",
        failure: null,
        hasOlder: false,
        ...options.transcripts?.[agentId],
      };
      transcripts.set(agentId, state);
    }
    return state;
  };
  const notify = (agentId: string) => {
    for (const listener of listeners.get(agentId) ?? []) listener();
  };

  const stores = {
    roster: {
      snapshots: { get: () => ({ agents: { selectedId: null, rows: options.rows } }) },
      interruptAgentRun: options.interruptAgentRun,
    },
    selection: {
      select: (agentId: string) => calls.select.push(agentId),
      readCurrentAgentId: () => null,
    },
    transcript: {
      snapshotsFor: (agentId: string) => ({
        get: () => stateFor(agentId),
        subscribe: (listener: () => void) => {
          const set = listeners.get(agentId) ?? new Set();
          set.add(listener);
          listeners.set(agentId, set);
          return () => set.delete(listener);
        },
      }),
      load: (agentId: string, loadOptions: unknown) => {
        calls.load.push({ agentId, options: loadOptions });
        setTimeout(() => {
          const state = stateFor(agentId);
          state.entries = options.unloaded?.[agentId] ?? [];
          state.loadState = "ready";
          notify(agentId);
        }, 1);
      },
      loadOlder: async (agentId: string) => {
        calls.loadOlder.push(agentId);
        const state = stateFor(agentId);
        state.entries = [...(options.olderEntries?.[agentId] ?? []), ...state.entries];
        state.hasOlder = false;
      },
      respondToWidget: options.respondToWidget,
    },
    sendJournal: {
      sendPrompt:
        options.sendPrompt ??
        (async (input: { onNonceAssigned?: (event: { nonce: string }) => void }) => {
          input.onNonceAssigned?.({ nonce: "grok-nonce" });
        }),
    },
    agentUsageRefusalHolds: {
      noteSent: (_agentId: string, nonce: string) => calls.noteSent.push(nonce),
    },
    egressTunnel: {
      claim: async () => {
        calls.egressClaims += 1;
      },
    },
  };

  // The old bridge drove Grok Bot's on-screen composer, whose `submitPrompt` takes a draft
  // snapshot, not a string: a string makes it throw before anything is sent.
  const shellProps = {
    agents: options.rows,
    currentAgentId: null,
    transcriptActionsRef: { current: { readEntries: () => [] } },
    screenInputs: {
      selectAgent: (agentId: string) => calls.select.push(agentId),
      composer: {
        submitPrompt: (snapshot: unknown) => {
          calls.composerSubmit.push(snapshot);
          (snapshot as { prompt: string }).prompt.trim();
        },
      },
    },
  };

  const consumer = {
    memoizedProps: {},
    dependencies:
      options.exposeStores === false
        ? null
        : {
            firstContext: {
              memoizedValue: { theme: "dark" },
              next: { memoizedValue: stores, next: null },
            },
          },
    child: null,
    sibling: null,
  };
  const rootNode: Record<string, unknown> = {
    __reactContainer$test: {
      current: {
        memoizedProps: {},
        child: { memoizedProps: shellProps, child: consumer, sibling: null },
        sibling: null,
      },
    },
  };
  const document = { getElementById: (id: string) => (id === "root" ? rootNode : null) };
  return { document, calls, stateFor };
}

const GROK_BOT = {
  id: "660da5a4",
  name: "Grok Bot",
  description: "A teammate with its own computer.",
  avatarDataUrl: null,
  avatarShape: "blob",
  avatarColor: "black",
  isRunning: true,
  isRunningTurn: false,
  isComposingMessage: false,
  lastMessagePreview: "I'm searching X",
  hasUnread: false,
  unreadCount: 0,
  lastActivityAt: 1795701360617,
  awaitingUserResponse: null,
  isRemovedFromSidebar: false,
  currentActivity: { kind: "tool", tool: "SetStatus", detail: "is searching X for composers" },
  runningSessionIds: [""],
};
const BRIDGE_BOT = {
  id: "65c30f51",
  name: "T3 Code Bridge",
  avatarShape: "blob",
  avatarColor: "red",
  isRunning: false,
  unreadCount: 2,
  lastActivityAt: 1793904939616,
  isRemovedFromSidebar: false,
};
const REMOVED_BOT = { id: "gone", name: "Removed", isRemovedFromSidebar: true };

const userMessage = (seq: number, content: string, extra: Entry = {}): Entry => ({
  kind: "message",
  id: `t${seq}u`,
  role: "user",
  content,
  isStreaming: false,
  timestampMs: 1000 + seq,
  clientNonce: `nonce-${seq}`,
  batchId: `nonce-${seq}`,
  seq,
  ...extra,
});
const botMessage = (seq: number, content: string): Entry => ({
  kind: "send-message",
  id: `t${seq}s`,
  message: { type: "text", content },
  timestampMs: 1000 + seq,
  seq,
});

describe("Grok Bot store bridge", () => {
  it("lists Bots from Grok Bot's roster store with live activity and open questions", async () => {
    const { document } = makeGrokRenderer({
      rows: [GROK_BOT, BRIDGE_BOT, REMOVED_BOT],
      transcripts: {
        [BRIDGE_BOT.id]: {
          loadState: "ready",
          entries: [
            userMessage(20, "Hook up T3"),
            {
              kind: "send-message",
              id: "t5s2",
              message: {
                type: "widget",
                widget: {
                  prompt: "Add your T3 Code connector now?",
                  options: [
                    { label: "Yes, connect T3", value: "Yes, add the T3 connector" },
                    { label: "Not yet", value: "Not yet" },
                  ],
                },
              },
              timestampMs: 1793902879555,
              seq: 22,
            },
          ],
        },
        [GROK_BOT.id]: {
          loadState: "ready",
          entries: [
            {
              kind: "send-message",
              id: "old-widget",
              message: { type: "widget", widget: { prompt: "Old?", options: [{ value: "a" }] } },
              seq: 1,
            },
            userMessage(2, "answered by typing instead"),
          ],
        },
      },
    });

    const envelope = await run(buildDiscoverBotsExpression(), document);

    expect(envelope.ok).toBe(true);
    expect(envelope.data?.bots).toEqual([
      expect.objectContaining({
        id: GROK_BOT.id,
        name: "Grok Bot",
        isRunning: true,
        activityDetail: "is searching X for composers",
        lastActivityAtMs: 1795701360617,
        avatarShape: "blob",
      }),
      expect.objectContaining({ id: BRIDGE_BOT.id, isRunning: false, unreadCount: 2 }),
    ]);
    expect(envelope.data?.widgets).toEqual([
      {
        botId: BRIDGE_BOT.id,
        entryId: "t5s2",
        prompt: "Add your T3 Code connector now?",
        options: [
          { label: "Yes, connect T3", value: "Yes, add the T3 connector" },
          { label: "Not yet", value: "Not yet" },
        ],
        timestampMs: 1793902879555,
      },
    ]);
  });

  it("reads a transcript without switching the chat Grok Bot shows", async () => {
    const { document, calls } = makeGrokRenderer({
      rows: [GROK_BOT],
      transcripts: {
        [GROK_BOT.id]: {
          loadState: "ready",
          entries: [
            userMessage(10, "Find composers"),
            botMessage(11, "On it."),
            {
              kind: "send-message",
              id: "t12s",
              message: { type: "attachment", file_name: "inspo.zip", url: "file:///box/inspo.zip" },
              seq: 12,
            },
            {
              kind: "send-message",
              id: "t13s",
              message: { type: "connector", connector: "t3" },
              seq: 13,
            },
            { kind: "event", id: "event-1", event: { type: "automation-changed" }, seq: 14 },
            userMessage(15, "Welcome", { fromAgent: { id: "other", name: "Trading" } }),
          ],
        },
      },
    });

    const envelope = await run(buildListMessagesExpression(GROK_BOT.id), document);

    expect(calls.select).toEqual([]);
    expect(calls.load).toEqual([]);
    const messages = normalizeGrokBotTranscript(GROK_BOT.id, envelope.data?.messages as unknown[]);
    expect(
      messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        attachments: message.attachments.map((attachment) => attachment.name),
        cardType: message.cardType,
        fromAgentName: message.fromAgentName,
        fromAgentId: message.fromAgentId,
      })),
    ).toEqual([
      {
        id: "t10u",
        role: "user",
        text: "Find composers",
        attachments: [],
        cardType: null,
        fromAgentName: null,
        fromAgentId: null,
      },
      {
        id: "t11s",
        role: "assistant",
        text: "On it.",
        attachments: [],
        cardType: null,
        fromAgentName: null,
        fromAgentId: null,
      },
      {
        id: "t12s",
        role: "assistant",
        text: "",
        attachments: ["inspo.zip"],
        cardType: null,
        fromAgentName: null,
        fromAgentId: null,
      },
      {
        id: "t13s",
        role: "assistant",
        text: "",
        attachments: [],
        cardType: "connector",
        fromAgentName: null,
        fromAgentId: null,
      },
      {
        id: "t15u",
        role: "user",
        text: "Welcome",
        attachments: [],
        cardType: null,
        fromAgentName: "Trading",
        fromAgentId: "other",
      },
    ]);
    expect(envelope.data?.nextCursor).toBeNull();
  });

  it("loads a Bot's transcript in the background when Grok Bot hasn't opened it yet", async () => {
    const { document, calls } = makeGrokRenderer({
      rows: [BRIDGE_BOT],
      unloaded: { [BRIDGE_BOT.id]: [userMessage(1, "hello"), botMessage(2, "hi")] },
    });

    const envelope = await run(buildListMessagesExpression(BRIDGE_BOT.id), document);

    expect(calls.load).toEqual([{ agentId: BRIDGE_BOT.id, options: { background: true } }]);
    expect(calls.select).toEqual([]);
    expect(envelope.data?.["messages"]).toHaveLength(2);
  });

  it("pages older history by sequence and asks Grok Bot for more at the edge", async () => {
    const recent = Array.from({ length: 60 }, (_, index) => botMessage(100 + index, `m${index}`));
    const { document, calls } = makeGrokRenderer({
      rows: [GROK_BOT],
      transcripts: { [GROK_BOT.id]: { loadState: "ready", entries: recent, hasOlder: true } },
      olderEntries: { [GROK_BOT.id]: [botMessage(98, "older-a"), botMessage(99, "older-b")] },
    });

    const latest = await run(buildListMessagesExpression(GROK_BOT.id), document);
    const latestMessages = latest.data?.messages as Array<{ seq: number }>;
    expect(latestMessages).toHaveLength(50);
    expect(latestMessages[0]?.seq).toBe(110);
    expect(latest.data?.nextCursor).toBe("110");

    const middle = await run(buildListMessagesExpression(GROK_BOT.id, "110"), document);
    const middleSeqs = ((middle.data?.messages ?? []) as Array<{ seq: number }>).map((m) => m.seq);
    expect(calls.loadOlder).toEqual([GROK_BOT.id]);
    expect(middleSeqs).toEqual([98, 99, ...Array.from({ length: 10 }, (_, i) => 100 + i)]);
    expect(middle.data?.nextCursor).toBeNull();
    expect(middle.data?.hasMore).toBe(false);
  });

  it("sends through Grok Bot's send journal, never its on-screen composer", async () => {
    const sent: Array<{ agentId: string; prompt: string }> = [];
    const { document, calls } = makeGrokRenderer({
      rows: [GROK_BOT, BRIDGE_BOT],
      sendPrompt: async (input) => {
        sent.push({ agentId: input.agentId, prompt: input.prompt });
        input.onNonceAssigned?.({ nonce: "grok-nonce-7" });
        input.onJournaled?.({});
        input.onDispatched?.({ agentId: input.agentId, nonce: "grok-nonce-7" });
      },
    });

    const envelope = await run(buildSendMessageExpression(BRIDGE_BOT.id, "Ship it"), document);

    expect(envelope).toEqual({
      ok: true,
      data: { accepted: true, nonce: "grok-nonce-7", state: "delivered" },
    });
    expect(sent).toEqual([{ agentId: BRIDGE_BOT.id, prompt: "Ship it" }]);
    expect(calls.noteSent).toEqual(["grok-nonce-7"]);
    expect(calls.egressClaims).toBe(1);
    expect(calls.composerSubmit).toEqual([]);
    expect(calls.select).toEqual([]);
  });

  it("returns Grok Bot's failure code when it refuses a send", async () => {
    const { document } = makeGrokRenderer({
      rows: [GROK_BOT],
      sendPrompt: async () => {
        throw new GrokSendFailure("send/agent-read-only");
      },
    });

    const envelope = await run(buildSendMessageExpression(GROK_BOT.id, "hi"), document);

    expect(envelope).toEqual({
      ok: false,
      reason: "action_rejected",
      code: "send/agent-read-only",
    });
  });

  it("accepts a send Grok Bot journaled but hasn't confirmed, and refuses one it never took", async () => {
    const journaled = makeGrokRenderer({
      rows: [GROK_BOT],
      sendPrompt: (input) => {
        input.onNonceAssigned?.({ nonce: "queued-nonce" });
        input.onJournaled?.({});
        return new Promise(() => undefined);
      },
    });
    expect(await run(buildSendMessageExpression(GROK_BOT.id, "hi"), journaled.document)).toEqual({
      ok: true,
      data: { accepted: true, nonce: "queued-nonce", state: "queued" },
    });

    const stuck = makeGrokRenderer({
      rows: [GROK_BOT],
      sendPrompt: () => new Promise(() => undefined),
    });
    expect(await run(buildSendMessageExpression(GROK_BOT.id, "hi"), stuck.document)).toEqual({
      ok: false,
      reason: "action_rejected",
      code: "send/timeout",
    });
  });

  it("reports unknown Bots and a renderer whose stores aren't mounted", async () => {
    const { document } = makeGrokRenderer({ rows: [GROK_BOT] });
    expect(await run(buildSendMessageExpression("missing", "hi"), document)).toEqual({
      ok: false,
      reason: "bot_not_found",
    });
    expect(await run(buildListMessagesExpression("missing"), document)).toEqual({
      ok: false,
      reason: "bot_not_found",
    });

    const signedOut = makeGrokRenderer({ rows: [GROK_BOT], exposeStores: false });
    expect(await run(buildDiscoverBotsExpression(), signedOut.document)).toEqual({
      ok: false,
      reason: "store_unavailable",
    });
  });

  it("stops every running session of a Bot", async () => {
    const interrupted: Array<{ agentId: string; sessionId?: string }> = [];
    const { document } = makeGrokRenderer({
      rows: [GROK_BOT, BRIDGE_BOT],
      interruptAgentRun: async (input) => {
        interrupted.push(input);
        return {};
      },
    });

    expect(await run(buildCancelRunExpression(GROK_BOT.id), document)).toEqual({
      ok: true,
      data: { cancelled: true },
    });
    expect(await run(buildCancelRunExpression(BRIDGE_BOT.id), document)).toEqual({
      ok: true,
      data: { cancelled: true },
    });
    expect(interrupted).toEqual([
      { agentId: GROK_BOT.id, sessionId: "" },
      { agentId: BRIDGE_BOT.id },
    ]);

    const failing = makeGrokRenderer({
      rows: [GROK_BOT],
      interruptAgentRun: async () => {
        throw new Error("nope");
      },
    });
    expect(await run(buildCancelRunExpression(GROK_BOT.id), failing.document)).toEqual({
      ok: true,
      data: { cancelled: false },
    });
  });

  it("answers a Bot's question through Grok Bot's widget store", async () => {
    const answers: Array<Record<string, unknown>> = [];
    const { document } = makeGrokRenderer({
      rows: [BRIDGE_BOT],
      respondToWidget: async (input) => {
        answers.push(input);
        return { accepted: true };
      },
    });

    expect(
      await run(buildRespondToWidgetExpression(BRIDGE_BOT.id, "t5s2", "Not yet"), document),
    ).toEqual({ ok: true, data: { accepted: true } });
    expect(answers).toEqual([{ agentId: BRIDGE_BOT.id, entryId: "t5s2", value: "Not yet" }]);

    const refused = makeGrokRenderer({
      rows: [BRIDGE_BOT],
      respondToWidget: async () => ({ accepted: false }),
    });
    expect(
      await run(buildRespondToWidgetExpression(BRIDGE_BOT.id, "t5s2", "Not yet"), refused.document),
    ).toEqual({ ok: false, reason: "action_rejected", code: null });
  });
});

describe("normalizeGrokBotTranscript", () => {
  const upload = (seq: number, batch: string, name: string): Entry => ({
    kind: "attachment",
    id: `t${seq}ua`,
    role: "user",
    seq,
    batchId: batch,
    clientNonce: batch,
    attachmentName: name,
    attachmentBytes: 2044046,
  });

  it("folds uploads into the message they were sent with and keeps upload-only sends in place", () => {
    const messages = normalizeGrokBotTranscript("bot", [
      upload(1, "only-image", "image.png"),
      { kind: "message", id: "t2s", role: "assistant", text: "Nice picture", seq: 2 },
      upload(3, "batch-b", "a.png"),
      upload(4, "batch-b", "b.png"),
      {
        kind: "message",
        id: "t5u",
        role: "user",
        text: "What are these?",
        seq: 5,
        batchId: "batch-b",
        clientNonce: "batch-b",
      },
      {
        kind: "message",
        id: "t6u",
        role: "user",
        text: "And this?",
        seq: 6,
        batchId: "batch-c",
        clientNonce: "batch-c",
      },
      upload(7, "batch-c", "c.png"),
    ]);

    expect(
      messages.map((message) => [message.id, message.text, message.attachments.map((a) => a.name)]),
    ).toEqual([
      ["t1ua", "", ["image.png"]],
      ["t2s", "Nice picture", []],
      ["t5u", "What are these?", ["a.png", "b.png"]],
      ["t6u", "And this?", ["c.png"]],
    ]);
    expect(messages[0]?.attachments[0]?.sizeBytes).toBe(2044046);
  });

  it("drops Grok Bot's local echo once the confirmed copy with the same nonce arrives", () => {
    const messages = normalizeGrokBotTranscript("bot", [
      {
        kind: "message",
        id: "optimistic",
        role: "user",
        text: "hi",
        clientNonce: "n1",
        timestampMs: 5,
      },
      { kind: "message", id: "t9u", role: "user", text: "hi", clientNonce: "n1", seq: 9 },
    ]);
    expect(messages.map((message) => message.id)).toEqual(["t9u"]);
  });
});
