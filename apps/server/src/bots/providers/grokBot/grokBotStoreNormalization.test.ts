import * as NodeVM from "node:vm";

import { describe, expect, it, vi } from "vite-plus/test";

import {
  buildCancelRunExpression,
  buildDiscoverBotsExpression,
  buildListMessagesExpression,
  buildSendMessageExpression,
} from "./grokBotStoreNormalization.ts";

interface MockDocument {
  getElementById: (id: string) => unknown;
  querySelector: (selector: string) => unknown;
  body?: unknown;
}

async function runExpression(expression: string, document: MockDocument): Promise<unknown> {
  const context = NodeVM.createContext({
    document,
    setTimeout,
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
  return await NodeVM.runInContext(expression, context);
}

function makeV130Document(options: {
  readonly agents: ReadonlyArray<Record<string, unknown>>;
  initialAgentId?: string;
  readonly entriesByAgent: Readonly<Record<string, ReadonlyArray<Record<string, unknown>>>>;
  readonly useOpenAgentChatFallback?: boolean;
  readonly omitComposer?: boolean;
  readonly onSelectAgent?: (botId: string) => void;
  readonly onSubmitPrompt?: (text: string, attachments: unknown[]) => void;
  readonly onCancelQueued?: () => void;
  readonly switchDelayTicks?: number;
}) {
  let currentAgentId = options.initialAgentId ?? null;
  let pendingAgentId: string | null = null;
  let ticksRemaining = 0;

  const selectFn = (botId: string) => {
    options.onSelectAgent?.(botId);
    if ((options.switchDelayTicks ?? 0) > 0) {
      pendingAgentId = botId;
      ticksRemaining = options.switchDelayTicks ?? 0;
    } else {
      currentAgentId = botId;
    }
  };

  const makeShellProps = () => {
    if (pendingAgentId !== null) {
      if (ticksRemaining <= 0) {
        currentAgentId = pendingAgentId;
        pendingAgentId = null;
      } else {
        ticksRemaining -= 1;
      }
    }

    const composer = options.omitComposer
      ? null
      : {
          submitPrompt: async (text: string, attachments: unknown[]) => {
            options.onSubmitPrompt?.(text, attachments);
          },
          sendActions: {
            cancelQueued: async () => {
              options.onCancelQueued?.();
            },
          },
        };

    return {
      agents: options.agents,
      currentAgentId,
      ...(options.useOpenAgentChatFallback ? { openAgentChat: selectFn } : {}),
      transcriptActionsRef: {
        current: {
          readEntries: async () =>
            currentAgentId ? (options.entriesByAgent[currentAgentId] ?? []) : [],
        },
      },
      screenInputs: {
        ...(options.useOpenAgentChatFallback ? {} : { selectAgent: selectFn }),
        composer,
      },
    };
  };

  const rootNode: Record<string, unknown> = {};
  Object.defineProperty(rootNode, "__reactContainer$v130", {
    enumerable: true,
    get: () => ({
      current: {
        memoizedProps: {},
        child: {
          memoizedProps: { wrapper: true },
          sibling: {
            memoizedProps: makeShellProps(),
            child: null,
            sibling: null,
          },
          child: null,
        },
        sibling: null,
      },
    }),
  });

  return {
    getElementById: (id: string) => (id === "root" ? rootNode : null),
    querySelector: () => null,
    body: null,
  } satisfies MockDocument;
}

describe("Grok Bot v1.3.0 React container Fiber bridge expressions", () => {
  it("discovers bots from root[__reactContainer$].current memoizedProps.{agents, transcriptActionsRef, screenInputs}", async () => {
    const doc = makeV130Document({
      agents: [
        {
          id: "agent-black",
          name: "Nightwatch",
          description: "Watches production alerts",
          avatarShape: "squircle",
          avatarColor: "black",
          isRunningTurn: true,
          awaitingUserResponse: false,
          unreadCount: 3,
          lastEntry: { text: "Investigating spike in region us-west" },
          lastActivityAt: 1_730_000_123_000,
        },
        {
          id: "agent-red",
          name: "Triage",
          shape: "diamond",
          color: "red",
          isComposingMessage: true,
          hasUnread: true,
        },
      ],
      initialAgentId: "agent-black",
      entriesByAgent: {},
    });

    const result = await runExpression(buildDiscoverBotsExpression(), doc);
    expect(result).toEqual({
      ok: true,
      data: {
        bots: [
          {
            id: "agent-black",
            name: "Nightwatch",
            description: "Watches production alerts",
            avatarDataUrl: undefined,
            avatarShape: "squircle",
            avatarColor: "black",
            status: undefined,
            isRunning: true,
            awaitingUserResponse: false,
            unreadCount: 3,
            hasUnread: false,
            lastMessagePreview: "Investigating spike in region us-west",
            lastActivityAtMs: 1_730_000_123_000,
          },
          {
            id: "agent-red",
            name: "Triage",
            description: undefined,
            avatarDataUrl: undefined,
            avatarShape: "diamond",
            avatarColor: "red",
            status: undefined,
            isRunning: true,
            awaitingUserResponse: false,
            unreadCount: undefined,
            hasUnread: true,
            lastMessagePreview: undefined,
            lastActivityAtMs: undefined,
          },
        ],
      },
    });
  });

  it("reads both kind:'message' (user) and kind:'send-message' (assistant message.content) entries and filters non-message entries", async () => {
    const selectAgent = vi.fn();
    const doc = makeV130Document({
      agents: [
        { id: "bot-a", name: "Alpha" },
        { id: "bot-b", name: "Beta" },
      ],
      initialAgentId: "bot-a",
      switchDelayTicks: 1,
      onSelectAgent: selectAgent,
      entriesByAgent: {
        "bot-b": [
          {
            id: "e-tool",
            kind: "tool-call",
            content: "ignored tool output",
          },
          {
            id: "e-1",
            seq: 1,
            kind: "message",
            role: "user",
            content: "Check the deploy status",
            createdAtMs: 1_000,
          },
          {
            id: "e-empty",
            seq: 2,
            kind: "send-message",
            message: { content: "   " },
          },
          {
            id: "e-2",
            seq: 3,
            kind: "send-message",
            message: { content: "All services are green." },
            timestampMs: 2_000,
          },
          {
            id: "e-3",
            seq: 4,
            kind: "send-message",
            message: "Direct string reply.",
            timestampMs: 3_000,
          },
          {
            id: "e-4",
            seq: 5,
            kind: "send-message",
            message: { text: "Text-field reply." },
            timestampMs: 4_000,
          },
        ],
      },
    });

    const result = await runExpression(buildListMessagesExpression("bot-b"), doc);
    expect(selectAgent).toHaveBeenCalledWith("bot-b");
    expect(result).toEqual({
      ok: true,
      data: {
        messages: [
          {
            id: "e-1",
            seq: 1,
            role: "user",
            text: "Check the deploy status",
            timestampMs: 1_000,
            clientNonce: null,
            replyToId: null,
            isStreaming: false,
          },
          {
            id: "e-2",
            seq: 3,
            role: "assistant",
            text: "All services are green.",
            timestampMs: 2_000,
            clientNonce: null,
            replyToId: null,
            isStreaming: false,
          },
          {
            id: "e-3",
            seq: 4,
            role: "assistant",
            text: "Direct string reply.",
            timestampMs: 3_000,
            clientNonce: null,
            replyToId: null,
            isStreaming: false,
          },
          {
            id: "e-4",
            seq: 5,
            role: "assistant",
            text: "Text-field reply.",
            timestampMs: 4_000,
            clientNonce: null,
            replyToId: null,
            isStreaming: false,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });
  });

  it("paginates shell entries in 50-message pages and reports bot_not_found for unknown ids", async () => {
    const entries = Array.from({ length: 65 }, (_, index) => ({
      id: `m-${index + 1}`,
      seq: index + 1,
      kind: index % 2 === 0 ? "message" : "send-message",
      ...(index % 2 === 0
        ? { role: "user", content: `Prompt ${index + 1}` }
        : { message: { content: `Reply ${index + 1}` } }),
    }));
    const doc = makeV130Document({
      agents: [{ id: "bot-page", name: "Pager" }],
      initialAgentId: "bot-page",
      entriesByAgent: { "bot-page": entries },
    });

    const latestPage = (await runExpression(buildListMessagesExpression("bot-page"), doc)) as {
      ok: true;
      data: { messages: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean };
    };
    expect(latestPage.ok).toBe(true);
    expect(latestPage.data.messages).toHaveLength(50);
    expect(latestPage.data.messages[0]?.id).toBe("m-16");
    expect(latestPage.data.messages[49]?.id).toBe("m-65");
    expect(latestPage.data.nextCursor).toBe("15");
    expect(latestPage.data.hasMore).toBe(true);

    const earlierPage = (await runExpression(
      buildListMessagesExpression("bot-page", "15"),
      doc,
    )) as {
      ok: true;
      data: { messages: Array<{ id: string }>; nextCursor: string | null; hasMore: boolean };
    };
    expect(earlierPage.ok).toBe(true);
    expect(earlierPage.data.messages).toHaveLength(15);
    expect(earlierPage.data.messages[0]?.id).toBe("m-1");
    expect(earlierPage.data.messages[14]?.id).toBe("m-15");
    expect(earlierPage.data.nextCursor).toBeNull();
    expect(earlierPage.data.hasMore).toBe(false);

    const missing = await runExpression(buildListMessagesExpression("bot-missing"), doc);
    expect(missing).toEqual({ ok: false, reason: "bot_not_found" });
  });

  it("switches via selectAgent (or openAgentChat fallback), submits via composer.submitPrompt, and cancels via sendActions.cancelQueued", async () => {
    const selectAgent = vi.fn();
    const submitPrompt = vi.fn();
    const cancelQueued = vi.fn();

    const doc = makeV130Document({
      agents: [
        { id: "bot-1", name: "One" },
        { id: "bot-2", name: "Two" },
      ],
      initialAgentId: "bot-1",
      entriesByAgent: {},
      onSelectAgent: selectAgent,
      onSubmitPrompt: submitPrompt,
      onCancelQueued: cancelQueued,
    });

    const sendRes = await runExpression(
      buildSendMessageExpression("bot-2", "Ship the fix", "nonce-42"),
      doc,
    );
    expect(selectAgent).toHaveBeenCalledWith("bot-2");
    expect(submitPrompt).toHaveBeenCalledWith("Ship the fix", []);
    expect(sendRes).toEqual({ ok: true, data: { accepted: true, messageId: null } });

    const cancelRes = await runExpression(buildCancelRunExpression("bot-2"), doc);
    expect(cancelQueued).toHaveBeenCalledTimes(1);
    expect(cancelRes).toEqual({ ok: true, data: { cancelled: true } });

    const missingSend = await runExpression(
      buildSendMessageExpression("bot-unknown", "Hello", "nonce-43"),
      doc,
    );
    expect(missingSend).toEqual({ ok: false, reason: "action_rejected" });

    // Also verify openAgentChat fallback when selectAgent is absent and error when composer is missing.
    const openChatSpy = vi.fn();
    const fallbackDoc = makeV130Document({
      agents: [
        { id: "bot-1", name: "One" },
        { id: "bot-2", name: "Two" },
      ],
      initialAgentId: "bot-1",
      useOpenAgentChatFallback: true,
      omitComposer: true,
      entriesByAgent: {
        "bot-2": [{ id: "m-1", kind: "send-message", message: { content: "Hi via fallback" } }],
      },
      onSelectAgent: openChatSpy,
    });

    const listedViaFallback = await runExpression(
      buildListMessagesExpression("bot-2"),
      fallbackDoc,
    );
    expect(openChatSpy).toHaveBeenCalledWith("bot-2");
    expect(listedViaFallback).toEqual({
      ok: true,
      data: {
        messages: [
          {
            id: "m-1",
            seq: null,
            role: "assistant",
            text: "Hi via fallback",
            timestampMs: null,
            clientNonce: null,
            replyToId: null,
            isStreaming: false,
          },
        ],
        nextCursor: null,
        hasMore: false,
      },
    });

    const noComposerSend = await runExpression(
      buildSendMessageExpression("bot-2", "Will fail", "nonce-44"),
      fallbackDoc,
    );
    expect(noComposerSend).toEqual({ ok: false, reason: "action_rejected" });
  });
});

describe("legacy Fiber context store backward compatibility", () => {
  it("falls back cleanly to .sand-agent-item __reactFiber$ context providers for discover, list, send, and cancel", async () => {
    const sendPrompt = vi.fn(async () => ({ id: "legacy-msg-9" }));
    const interruptAgentRun = vi.fn(async () => undefined);

    const transcriptFiber = {
      memoizedProps: {
        value: {
          byAgentId: {
            "legacy-1": [
              { id: "l-1", seq: 1, role: "user", text: "Legacy ping", timestampMs: 500 },
            ],
          },
          sendPrompt,
          interruptAgentRun,
        },
      },
      return: null,
    };

    const rosterFiber = {
      memoizedProps: {
        value: {
          getAgents: async () => [
            {
              id: "legacy-1",
              name: "Legacy Bot",
              avatarShape: "blob",
              avatarColor: "blue",
              status: "idle",
            },
          ],
        },
      },
      return: transcriptFiber,
    };

    const sandItem = {
      __reactFiber$legacy: rosterFiber,
    };

    const legacyDoc: MockDocument = {
      getElementById: () => null,
      querySelector: (selector: string) => (selector === ".sand-agent-item" ? sandItem : null),
      body: null,
    };

    const discovered = await runExpression(buildDiscoverBotsExpression(), legacyDoc);
    expect(discovered).toEqual({
      ok: true,
      data: {
        bots: [
          {
            id: "legacy-1",
            name: "Legacy Bot",
            description: undefined,
            avatarDataUrl: undefined,
            avatarShape: "blob",
            avatarColor: "blue",
            status: "idle",
            isRunning: false,
            awaitingUserResponse: false,
            unreadCount: undefined,
            hasUnread: false,
            lastMessagePreview: undefined,
            lastActivityAtMs: undefined,
          },
        ],
      },
    });

    const listed = await runExpression(buildListMessagesExpression("legacy-1"), legacyDoc);
    expect(listed).toEqual({
      ok: true,
      data: {
        messages: [{ id: "l-1", seq: 1, role: "user", text: "Legacy ping", timestampMs: 500 }],
        nextCursor: null,
        hasMore: false,
      },
    });

    const sent = await runExpression(
      buildSendMessageExpression("legacy-1", "Legacy send", "nonce-legacy"),
      legacyDoc,
    );
    expect(sendPrompt).toHaveBeenCalledWith({
      agentId: "legacy-1",
      text: "Legacy send",
      clientNonce: "nonce-legacy",
    });
    expect(sent).toEqual({ ok: true, data: { accepted: true, messageId: "legacy-msg-9" } });

    const cancelled = await runExpression(buildCancelRunExpression("legacy-1"), legacyDoc);
    expect(interruptAgentRun).toHaveBeenCalledWith("legacy-1");
    expect(cancelled).toEqual({ ok: true, data: { cancelled: true } });

    const emptyDoc: MockDocument = {
      getElementById: () => null,
      querySelector: () => null,
      body: null,
    };
    expect(await runExpression(buildDiscoverBotsExpression(), emptyDoc)).toEqual({
      ok: false,
      reason: "store_unavailable",
    });
  });
});
