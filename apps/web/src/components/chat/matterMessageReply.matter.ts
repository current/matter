import type { LegendListRef } from "@legendapp/list/react";
import { stripReplyMarkdownToPlainText } from "@t3tools/client-runtime/matter/message-reply";
import {
  type EnvironmentId,
  type MessageId,
  type ResponseContextRecord,
  type ScopedThreadRef,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef } from "react";

import { captureAssistantMessageOpening } from "~/lib/assistantTextSelection";
import { responseContextRecord } from "~/lib/composerContextRecords";
import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export {
  extractLeadingReplyReference,
  extractReplyExcerpt,
  MATTER_REPLY_EXCERPT_MAX_CHARS,
  resolveReplyRole,
  type ExtractedLeadingReply,
  type MatterReplyRole,
} from "@t3tools/client-runtime/matter/message-reply";

const MATTER_REPLY_HIGHLIGHT_DURATION_MS = 1_600;

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
  const cleanedFallback = stripReplyMarkdownToPlainText(input.rawText);
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
