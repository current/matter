import type { LegendListRef } from "@legendapp/list/react";
import {
  type ComposerContextRecord,
  type EnvironmentId,
  type MessageId,
  type ResponseContextRecord,
  type ScopedThreadRef,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { useEffect, useEffectEvent, useRef } from "react";

import { captureAssistantMessageOpening } from "~/lib/assistantTextSelection";
import { isResponseContextRecord, responseContextRecord } from "~/lib/composerContextRecords";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export type MatterReplyRole = "user" | "assistant";

export const MATTER_REPLY_EXCERPT_MAX_CHARS = 180;
const MATTER_REPLY_HIGHLIGHT_DURATION_MS = 1_600;

function stripMarkdownToPlainText(input: string): string {
  // Replace inline composer context references first: drop nested reply refs, keep other labels.
  let text = replaceComposerContextReferences(input, (reference) =>
    reference.kind === "response" ? "" : reference.label,
  );
  // Replace serialized assistant citation markdown links with their quoted plain text.
  text = assistantCitationsToPlainText(text);
  // Strip fenced code block markers while preserving inner code lines.
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, " $1 ");
  text = text.replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, " $1 ");
  // Unwrap inline code spans.
  text = text.replace(/`+([^`]+)`+/g, "$1");
  // Markdown images -> alt text; markdown links -> link text.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  // Reference-style links [text][ref] -> text.
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  // Line-level block syntax: headings, blockquotes, horizontal rules, task/bullet/ordered lists.
  text = text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (/^[-*_]{3,}$/.test(trimmed)) return "";
      return line
        .replace(/^\s{0,3}#{1,6}\s+/, "")
        .replace(/^\s*(?:>\s*)+/, "")
        .replace(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX]\]\s+)?/, "");
    })
    .join(" ");
  // Emphasis / strikethrough delimiters.
  text = text
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s([{"'])\*([^*\n]+)\*(?=$|[\s.,!?;:)\]}"'])/g, "$1$2")
    .replace(/(^|[\s([{"'])_([^_\n]+)_(?=$|[\s.,!?;:)\]}"'])/g, "$1$2");
  // Collapse whitespace into single spaces.
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extracts a crisp, single-line plain-text excerpt from markdown or plain message text,
 * capped cleanly without splitting UTF-16 surrogate pairs.
 */
export function extractReplyExcerpt(
  rawText: string,
  maxChars: number = MATTER_REPLY_EXCERPT_MAX_CHARS,
): string {
  const plain = stripMarkdownToPlainText(rawText);
  if (plain.length === 0) return "";
  if (maxChars <= 0) return "";
  if (plain.length <= maxChars) return plain;
  let end = Math.max(1, maxChars - 1);
  // Avoid splitting a UTF-16 surrogate pair.
  const previous = plain.charCodeAt(end - 1);
  const next = plain.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  const sliced = plain.slice(0, end).replace(/[\s,;:–—-]+$/u, "");
  return `${sliced || plain.slice(0, end)}…`;
}

export function resolveReplyRole(record: ResponseContextRecord): MatterReplyRole {
  return record.role === "user" ? "user" : "assistant";
}

export interface ExtractedLeadingReply {
  readonly record: ResponseContextRecord;
  readonly bodyText: string;
}

/**
 * When a user message starts with a reply reference followed by message body text,
 * splits them so the timeline can render a sleek reply reference header above the bubble.
 * Reply-only messages (empty body) stay in-bubble so the bubble is never blank.
 */
export function extractLeadingReplyReference(
  text: string,
  recordsById: ReadonlyMap<string, ComposerContextRecord>,
): ExtractedLeadingReply | null {
  const trimmedStart = text.trimStart();
  const leadingOffset = text.length - trimmedStart.length;
  const firstReference = collectComposerContextReferences(trimmedStart)[0];
  if (!firstReference || firstReference.start !== 0 || firstReference.kind !== "response") {
    return null;
  }
  const candidate = recordsById.get(firstReference.contextId);
  if (!candidate || !isResponseContextRecord(candidate)) {
    return null;
  }
  const remainder = text.slice(leadingOffset + firstReference.end).replace(/^[ \t]+/, "");
  const bodyText = remainder.replace(/^\r?\n/, "");
  if (bodyText.trim().length === 0) {
    return null;
  }
  return { record: candidate, bodyText };
}

/**
 * Builds a `ResponseContextRecord` targeting a user message in the current thread.
 * Strips any leading nested reply reference from the fallback text so replying to a reply
 * quotes the user's own words rather than the previous reply card.
 */
export function buildUserMessageReplyRecord(input: {
  readonly threadRef: ScopedThreadRef;
  readonly messageId: MessageId;
  readonly itemId: TurnItemId | undefined;
  readonly rawText: string;
  readonly sourceElement?: HTMLElement | null;
}): ResponseContextRecord | null {
  const cleanedFallback = stripMarkdownToPlainText(input.rawText);
  const opening = captureAssistantMessageOpening(
    input.sourceElement ?? null,
    cleanedFallback || input.rawText,
  );
  if (!opening) return null;
  return responseContextRecord({
    role: "user",
    citation: {
      version: 1,
      ...input.threadRef,
      messageId: input.messageId,
      ...opening,
    },
    itemId: input.itemId ?? TurnItemId.make(input.messageId),
    subagents: [],
  });
}

export interface MatterMessageRevealRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly nonce: number;
}

type RevealListener = (request: MatterMessageRevealRequest) => void;

let revealNonce = 0;
let pendingReveal: MatterMessageRevealRequest | null = null;
const revealListeners = new Set<RevealListener>();

export function requestMatterMessageReveal(target: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
}): MatterMessageRevealRequest {
  revealNonce += 1;
  const request: MatterMessageRevealRequest = {
    environmentId: target.environmentId,
    threadId: target.threadId,
    messageId: target.messageId,
    nonce: revealNonce,
  };
  pendingReveal = request;
  for (const listener of revealListeners) {
    listener(request);
  }
  return request;
}

export function clearPendingMatterMessageRevealForTests(): void {
  pendingReveal = null;
}

function subscribeMatterMessageReveal(listener: RevealListener): () => void {
  revealListeners.add(listener);
  return () => {
    revealListeners.delete(listener);
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function findMessageRowElement(
  messageId: MessageId,
  viewport?: HTMLElement | null,
): HTMLElement | null {
  const root: ParentNode = viewport ?? document;
  return (
    root.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"][data-message-role]`,
    ) ?? root.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(messageId)}"]`)
  );
}

/**
 * Listens for Matter message-reveal requests targeting the current thread, scrolls LegendList
 * smoothly to the referenced message (paging older history when needed), and flashes a finite
 * DOM highlight attribute directly on the row with zero React row re-renders.
 */
export function useMatterMessageReveal(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly listRef: React.RefObject<LegendListRef | null>;
  readonly viewport?: HTMLElement | null;
  readonly onManualNavigation: () => void;
  readonly hasMoreHistory?: boolean | undefined;
  readonly onLoadEarlier?: ((throughEntryId?: string) => void) | undefined;
}): void {
  const { threadRef, rows, listRef, viewport, onManualNavigation, hasMoreHistory, onLoadEarlier } =
    input;
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  const activeRequestRef = useRef<MatterMessageRevealRequest | null>(null);
  const requestedHistoryNonceRef = useRef<number | null>(null);
  const handledNonceRef = useRef<number | null>(null);
  const cleanupHighlightRef = useRef<(() => void) | null>(null);

  const tryFulfillReveal = useEffectEvent((currentRows: ReadonlyArray<MessagesTimelineRow>) => {
    const request = activeRequestRef.current;
    if (!request || environmentId === null || threadId === null) return;
    if (
      request.environmentId !== environmentId ||
      request.threadId !== threadId ||
      handledNonceRef.current === request.nonce
    ) {
      return;
    }
    const rowIndex = currentRows.findIndex(
      (row) => row.kind === "message" && row.message.id === request.messageId,
    );
    if (rowIndex === -1) {
      if (hasMoreHistory && onLoadEarlier && requestedHistoryNonceRef.current !== request.nonce) {
        requestedHistoryNonceRef.current = request.nonce;
        onLoadEarlier(request.messageId);
      } else if (!hasMoreHistory || !onLoadEarlier) {
        handledNonceRef.current = request.nonce;
        activeRequestRef.current = null;
        if (pendingReveal?.nonce === request.nonce) {
          pendingReveal = null;
        }
      }
      return;
    }

    handledNonceRef.current = request.nonce;
    activeRequestRef.current = null;
    if (pendingReveal?.nonce === request.nonce) {
      pendingReveal = null;
    }
    onManualNavigation();
    const list = listRef.current;
    const animated = !prefersReducedMotion();
    if (list && typeof list.scrollToIndex === "function") {
      try {
        void list.scrollToIndex({ index: rowIndex, animated, viewPosition: 0.35 });
      } catch {
        // Fallback below handles synthetic or unmeasured lists.
      }
    }

    cleanupHighlightRef.current?.();
    cleanupHighlightRef.current = null;

    let highlightedElement: HTMLElement | null = null;
    let clearTimer: number | null = null;
    let observer: MutationObserver | null = null;
    let observerTimer: number | null = null;

    const cleanup = () => {
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
        clearTimer = null;
      }
      if (observerTimer !== null) {
        window.clearTimeout(observerTimer);
        observerTimer = null;
      }
      observer?.disconnect();
      observer = null;
      if (highlightedElement) {
        delete highlightedElement.dataset.matterReplyHighlight;
        highlightedElement = null;
      }
    };

    const applyHighlight = (element: HTMLElement) => {
      observer?.disconnect();
      observer = null;
      if (observerTimer !== null) {
        window.clearTimeout(observerTimer);
        observerTimer = null;
      }
      if (typeof element.scrollIntoView === "function") {
        element.scrollIntoView({
          block: "center",
          behavior: animated ? "smooth" : "instant",
        });
      }
      highlightedElement = element;
      delete element.dataset.matterReplyHighlight;
      // Force reflow when re-highlighting the same message so the one-shot animation restarts.
      void element.offsetWidth;
      element.dataset.matterReplyHighlight = "true";
      clearTimer = window.setTimeout(cleanup, MATTER_REPLY_HIGHLIGHT_DURATION_MS);
    };

    cleanupHighlightRef.current = cleanup;
    const immediate = findMessageRowElement(request.messageId, viewport);
    const observeRoot = viewport ?? document.body;
    if (immediate) {
      applyHighlight(immediate);
    } else if (typeof MutationObserver !== "undefined" && observeRoot) {
      observer = new MutationObserver(() => {
        const mounted = findMessageRowElement(request.messageId, viewport);
        if (mounted) applyHighlight(mounted);
      });
      observer.observe(observeRoot, { childList: true, subtree: true });
      observerTimer = window.setTimeout(cleanup, 1_500);
    }
  });

  const tryFulfillCurrentRows = useEffectEvent(() => {
    tryFulfillReveal(rows);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to external message-reveal events for the active thread and clears highlight state on thread change
  useEffect(() => {
    if (environmentId === null || threadId === null) return;
    if (
      pendingReveal &&
      pendingReveal.environmentId === environmentId &&
      pendingReveal.threadId === threadId &&
      handledNonceRef.current !== pendingReveal.nonce
    ) {
      activeRequestRef.current = pendingReveal;
      tryFulfillCurrentRows();
    }
    const unsubscribe = subscribeMatterMessageReveal((request) => {
      if (request.environmentId === environmentId && request.threadId === threadId) {
        activeRequestRef.current = request;
        tryFulfillCurrentRows();
      }
    });
    return () => {
      unsubscribe();
      activeRequestRef.current = null;
      cleanupHighlightRef.current?.();
      cleanupHighlightRef.current = null;
    };
  }, [environmentId, threadId]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fulfills a pending message reveal once newly paged rows arrive
  useEffect(() => {
    if (activeRequestRef.current) {
      tryFulfillReveal(rows);
    }
  }, [rows]);
}
