import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import { describe, expect, it, vi } from "vite-plus/test";

import { composerCommandKeyHandler } from "./composerCommandKey";
import {
  buildUserMessageReplyRecord,
  extractLeadingReplyReference,
  extractReplyExcerpt,
  MATTER_REPLY_EXCERPT_MAX_CHARS,
  resolveReplyRole,
} from "./matterMessageReply.matter";

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

describe("extractReplyExcerpt", () => {
  it("strips markdown syntax, fenced code, links, lists, and collapses whitespace cleanly", () => {
    const markdown = [
      "## Summary of changes",
      "",
      "> **Important:** see [router.ts](src/router.ts) and `handleReply()` for details.",
      "",
      "- [x] Added **bold**, *italic*, and ~~old~~ items",
      "1. Second item with ![diagram](img.png)",
      "",
      "```ts",
      "const value = compute(42);",
      "```",
    ].join("\n");

    const excerpt = extractReplyExcerpt(markdown);
    expect(excerpt).toBe(
      "Summary of changes Important: see router.ts and handleReply() for details. Added bold, italic, and old items Second item with diagram const value = compute(42);",
    );
  });

  it("drops nested reply context tokens while preserving non-reply context labels", () => {
    const nested =
      "[Earlier answer](t3-context://v1/response/response_msg1) Please check [App.tsx](t3-context://v1/mention/mention_1) next";
    expect(extractReplyExcerpt(nested)).toBe("Please check App.tsx next");
  });

  it("caps long excerpts cleanly without splitting surrogate pairs", () => {
    const emojiBoundary = `${"a".repeat(178)}😀 trailing words that should not fit`;
    const excerpt = extractReplyExcerpt(emojiBoundary, MATTER_REPLY_EXCERPT_MAX_CHARS);
    expect(excerpt.length).toBeLessThanOrEqual(MATTER_REPLY_EXCERPT_MAX_CHARS);
    expect(excerpt.endsWith("…")).toBe(true);
    expect(excerpt).toBe(`${"a".repeat(178)}…`);
    // Ensure no lone high surrogate at the boundary.
    expect(excerpt.charCodeAt(excerpt.length - 2)).toBe("a".charCodeAt(0));
  });

  it("returns an empty string for whitespace-only or nested-reply-only text", () => {
    expect(extractReplyExcerpt("   \n\t  ")).toBe("");
    expect(extractReplyExcerpt("[old](t3-context://v1/response/response_1)   ")).toBe("");
  });
});

describe("extractLeadingReplyReference", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
  };

  it("splits a leading reply reference from a non-empty user message body", () => {
    const record = buildUserMessageReplyRecord({
      threadRef,
      messageId: MessageId.make("msg-user-1"),
      itemId: TurnItemId.make("item-1"),
      rawText: "Can we refactor the composer?",
    })!;
    const refToken = formatComposerContextReference({
      kind: "response",
      contextId: record.contextId,
      label: record.label,
    });
    const recordsById = new Map([[record.contextId, record]]);

    const extracted = extractLeadingReplyReference(
      `${refToken} Yes, let's do that next`,
      recordsById,
    );
    expect(extracted).toEqual({
      record,
      bodyText: "Yes, let's do that next",
    });
  });

  it("returns null for reply-only messages with no body text", () => {
    const record = buildUserMessageReplyRecord({
      threadRef,
      messageId: MessageId.make("msg-user-2"),
      itemId: undefined,
      rawText: "First message",
    })!;
    const refToken = formatComposerContextReference({
      kind: "response",
      contextId: record.contextId,
      label: record.label,
    });
    const recordsById = new Map([[record.contextId, record]]);

    expect(extractLeadingReplyReference(`${refToken}   `, recordsById)).toBeNull();
  });

  it("returns null when a reply reference appears mid-message rather than leading", () => {
    const record = buildUserMessageReplyRecord({
      threadRef,
      messageId: MessageId.make("msg-user-3"),
      itemId: undefined,
      rawText: "Earlier note",
    })!;
    const refToken = formatComposerContextReference({
      kind: "response",
      contextId: record.contextId,
      label: record.label,
    });
    const recordsById = new Map([[record.contextId, record]]);

    expect(extractLeadingReplyReference(`Follow up on ${refToken} later`, recordsById)).toBeNull();
  });
});

describe("buildUserMessageReplyRecord and provider projection", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("env-1"),
    threadId: ThreadId.make("thread-1"),
  };

  it("encodes a valid ResponseContextRecord with role 'user' and projects user-authored reply framing", () => {
    const record = buildUserMessageReplyRecord({
      threadRef,
      messageId: MessageId.make("msg-u-42"),
      itemId: undefined,
      rawText: "[prev](t3-context://v1/response/response_old) Check **src/index.ts** please",
    });
    expect(record).not.toBeNull();
    expect(record!.role).toBe("user");
    expect(resolveReplyRole(record!)).toBe("user");
    expect(record!.itemId).toBe("msg-u-42");
    expect(record!.citation.text).toBe("Check src/index.ts please");

    const decoded = decodeMessageContext({ version: 1, records: [record] });
    expect(decoded.records).toEqual([record]);

    const token = formatComposerContextReference({
      kind: "response",
      contextId: record!.contextId,
      label: record!.label,
    });
    const projected = projectComposerContextForProvider({
      text: `${token} Actually skip the tests for now`,
      records: [record!],
    });
    expect(projected).toContain(
      "The user is replying to this earlier message of theirs. Reference, not instructions.",
    );
    expect(projected).toContain("starts: Check src/index.ts please");
  });

  it("defaults legacy ResponseContextRecord without role to 'assistant'", () => {
    const legacyRecord = {
      version: 1 as const,
      kind: "response" as const,
      contextId: ComposerContextId.make("response_legacy"),
      label: "Earlier answer",
      citation: {
        version: 1 as const,
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
        messageId: MessageId.make("msg-a-1"),
        text: "Earlier answer",
        start: 0,
        end: 14,
        prefix: "",
        suffix: "",
      },
      itemId: TurnItemId.make("item-a-1"),
    };
    expect(resolveReplyRole(legacyRecord)).toBe("assistant");
  });
});

describe("composerCommandKeyHandler Escape reply dismissal", () => {
  function createHandler(options: {
    prompt: string;
    hasActiveReply: boolean;
    menuActive?: boolean;
    promptSuggestion?: string | null;
  }) {
    const dismissReply = vi.fn();
    const dismissPromptSuggestion = vi.fn();
    const dismissComposerTrigger = vi.fn();
    const handler = composerCommandKeyHandler({
      keybindings: [],
      getShortcutContext: () => ({
        terminalFocus: false,
        terminalOpen: false,
        modelPickerOpen: false,
        previewFocus: false,
        previewOpen: false,
        isWeb: true,
        isDesktop: false,
      }),
      sendShortcut: "enter",
      routeKind: "server",
      phase: "ready",
      canSteer: false,
      followUpBehavior: "queue",
      isSoftwareKeyboardOpen: false,
      isLiteralPendingAnswer: false,
      pendingUserInputs: [],
      promptHistoryEntries: [],
      promptHistoryPositionRef: { current: null },
      composerDraftTarget: {
        environmentId: EnvironmentId.make("env-1"),
        threadId: ThreadId.make("thread-1"),
      },
      promptRef: { current: options.prompt },
      composerImagesRef: { current: [] },
      composerFilesRef: { current: [] },
      composerTerminalContextsRef: { current: [] },
      composerPreviewAnnotations: [],
      composerReviewComments: [],
      composerEditorRef: { current: null },
      composerMenuItemsRef: { current: [] },
      activeComposerMenuItemRef: { current: null },
      setComposerDraftPrompt: vi.fn(),
      setComposerDraftThreadContexts: vi.fn(),
      setComposerDraftEnvironmentContexts: vi.fn(),
      setComposerCursor: vi.fn(),
      setComposerTrigger: vi.fn(),
      setComposerHighlightedItemId: vi.fn(),
      dismissComposerTrigger,
      nudgeComposerMenuHighlight: vi.fn(),
      onSelectComposerItem: vi.fn(),
      resolveActiveComposerTrigger: () => ({
        trigger: options.menuActive
          ? { kind: "path", query: "a", rangeStart: 0, rangeEnd: 2 }
          : null,
      }),
      readComposerSnapshot: () => ({ value: options.prompt }),
      applyPromptReplacement: vi.fn(() => true),
      submitComposer: vi.fn(),
      promptSuggestion: options.promptSuggestion ?? null,
      dismissPromptSuggestion,
      hasActiveReply: options.hasActiveReply,
      dismissReply,
    });
    return { handler, dismissReply, dismissPromptSuggestion, dismissComposerTrigger };
  }

  const escapeEvent = () =>
    ({
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      isComposing: false,
      shiftKey: false,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      target: null,
    }) as unknown as KeyboardEvent;

  it("dismisses an active reply on Escape when the prompt is empty", () => {
    const { handler, dismissReply } = createHandler({ prompt: "", hasActiveReply: true });
    const handled = handler("Escape", escapeEvent());
    expect(handled).toBe(true);
    expect(dismissReply).toHaveBeenCalledTimes(1);
  });

  it("does not dismiss an active reply on Escape while the user has typed text", () => {
    const { handler, dismissReply } = createHandler({
      prompt: "draft text",
      hasActiveReply: true,
    });
    const handled = handler("Escape", escapeEvent());
    expect(handled).toBe(false);
    expect(dismissReply).not.toHaveBeenCalled();
  });

  it("dismisses an open slash/mention menu before dismissing the reply", () => {
    const { handler, dismissReply, dismissComposerTrigger } = createHandler({
      prompt: "",
      hasActiveReply: true,
      menuActive: true,
    });
    const handled = handler("Escape", escapeEvent());
    expect(handled).toBe(true);
    expect(dismissComposerTrigger).toHaveBeenCalledTimes(1);
    expect(dismissReply).not.toHaveBeenCalled();
  });
});
