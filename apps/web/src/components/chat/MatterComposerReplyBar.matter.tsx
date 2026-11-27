import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type {
  MessageId,
  ResponseContextRecord,
  ScopedThreadRef,
  TurnItemId,
} from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { ReplyIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { assistantCitationNavigation } from "~/lib/assistantCitationNavigation";
import { cn } from "~/lib/utils";
import { readThreadShell } from "~/state/entities";
import { textDirection } from "~/textDirection";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useMatterDismissFade } from "./matterDismissFade.matter";
import {
  buildUserMessageReplyRecord,
  extractReplyExcerpt,
  requestMatterMessageReveal,
  resolveReplyRole,
} from "./matterMessageReply.matter";

function useJumpToRepliedMessage(currentThreadRef?: ScopedThreadRef | null) {
  const router = useRouter({ warn: false });

  return (record: ResponseContextRecord) => {
    const role = resolveReplyRole(record);
    const { citation } = record;
    const sameThread =
      currentThreadRef !== undefined &&
      currentThreadRef !== null &&
      currentThreadRef.environmentId === citation.environmentId &&
      currentThreadRef.threadId === citation.threadId;

    if (role === "user") {
      requestMatterMessageReveal({
        environmentId: citation.environmentId,
        threadId: citation.threadId,
        messageId: citation.messageId,
      });
      if (!sameThread && router) {
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: citation.environmentId,
            threadId: citation.threadId,
          },
          resetScroll: false,
        });
      }
      return;
    }

    if (router) {
      const source = readThreadShell(scopeThreadRef(citation.environmentId, citation.threadId));
      void router.navigate(assistantCitationNavigation(citation, source));
      return;
    }
    requestMatterMessageReveal({
      environmentId: citation.environmentId,
      threadId: citation.threadId,
      messageId: citation.messageId,
    });
  };
}

/**
 * Tactile in-card reply banner docked at the top of Matter's prompt card.
 * Shows who Chris is replying to, a clean 1-line truncated excerpt (clickable to jump to
 * the target message), and a crisp dismiss control.
 */
export function MatterComposerReplyBar({
  replyTo,
  currentThreadRef,
  onJumpToMessage,
  onDismiss,
}: {
  readonly replyTo: ResponseContextRecord;
  readonly currentThreadRef?: ScopedThreadRef | null;
  readonly onJumpToMessage?: (record: ResponseContextRecord) => void;
  readonly onDismiss: () => void;
}) {
  const gt = useGT();
  const defaultJump = useJumpToRepliedMessage(currentThreadRef);
  const role = resolveReplyRole(replyTo);
  const subagentTitles = replyTo.subagents?.length
    ? replyTo.subagents.map((subagent) => subagent.title).join(", ")
    : null;
  const heading = subagentTitles
    ? gt("Replying to {titles}", { titles: subagentTitles })
    : role === "user"
      ? gt("Replying to you")
      : gt("Replying to assistant");
  const excerpt = extractReplyExcerpt(replyTo.citation.text) || replyTo.label;
  const targetKey = `${role}:${replyTo.citation.messageId}:${excerpt}`;
  const [targetState, setTargetState] = useState({ key: targetKey, switched: false });
  if (targetState.key !== targetKey) {
    setTargetState({ key: targetKey, switched: true });
  }
  const { dismissing, triggerDismiss } = useMatterDismissFade(onDismiss, 120, targetKey);
  const handleJump = () => {
    if (onJumpToMessage) {
      onJumpToMessage(replyTo);
      return;
    }
    defaultJump(replyTo);
  };

  return (
    <div
      data-matter-reply-bar=""
      data-matter-reply-role={role}
      data-matter-reply-message-id={replyTo.citation.messageId}
      data-dismissing={dismissing ? "true" : undefined}
    >
      <ReplyIcon aria-hidden="true" data-matter-reply-bar-icon="" />
      <button
        type="button"
        data-matter-reply-bar-jump=""
        onClick={handleJump}
        aria-label={gt("Jump to replied message: {excerpt}", { excerpt })}
      >
        <span
          key={`heading:${targetState.key}`}
          data-matter-reply-bar-heading=""
          data-matter-reply-switch={targetState.switched ? "" : undefined}
        >
          {heading}
        </span>
        {excerpt ? (
          <>
            <span aria-hidden="true" data-matter-reply-bar-sep="">
              ·
            </span>
            <span
              key={`excerpt:${targetState.key}`}
              data-matter-reply-bar-excerpt=""
              data-matter-reply-switch={targetState.switched ? "" : undefined}
            >
              {excerpt}
            </span>
          </>
        ) : null}
      </button>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              data-matter-reply-bar-dismiss=""
              onClick={triggerDismiss}
              aria-label={gt("Cancel reply")}
            />
          }
        >
          <XIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <T>Cancel reply</T>
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

/**
 * Compact clickable reply reference header rendered right above a sent user message bubble.
 */
export function MatterSentReplyHeader({
  record,
  currentThreadRef,
  onJumpToMessage,
}: {
  readonly record: ResponseContextRecord;
  readonly currentThreadRef?: ScopedThreadRef | null;
  readonly onJumpToMessage?: (record: ResponseContextRecord) => void;
}) {
  const gt = useGT();
  const defaultJump = useJumpToRepliedMessage(currentThreadRef);
  const role = resolveReplyRole(record);
  const subagentTitles = record.subagents?.length
    ? record.subagents.map((subagent) => subagent.title).join(", ")
    : null;
  const authorLabel =
    subagentTitles ??
    (role === "user"
      ? gt("you", { $context: "lowercase author tag in a sent reply reference" })
      : gt("assistant", { $context: "lowercase author tag in a sent reply reference" }));
  const excerpt = extractReplyExcerpt(record.citation.text) || record.label;
  const handleJump = () => {
    if (onJumpToMessage) {
      onJumpToMessage(record);
      return;
    }
    defaultJump(record);
  };

  return (
    <button
      type="button"
      data-matter-reply-header=""
      data-matter-reply-role={role}
      data-matter-reply-message-id={record.citation.messageId}
      data-thread-find-ignore=""
      onClick={handleJump}
      aria-label={gt("Go to replied message from {author}: {excerpt}", {
        author: authorLabel,
        excerpt,
      })}
    >
      <ReplyIcon aria-hidden="true" data-matter-reply-header-icon="" />
      <span data-matter-reply-header-author="">{authorLabel}</span>
      {excerpt ? (
        <>
          <span aria-hidden="true" data-matter-reply-header-sep="">
            ·
          </span>
          <span data-matter-reply-header-excerpt="">{excerpt}</span>
        </>
      ) : null}
    </button>
  );
}

/**
 * Reply action button rendered inside the hover action bar of user messages.
 */
export function MatterUserReplyButton({
  messageId,
  itemId,
  rawText,
  threadRef,
  onReply,
}: {
  readonly messageId: MessageId;
  readonly itemId: TurnItemId | undefined;
  readonly rawText: string;
  readonly threadRef: ScopedThreadRef | null;
  readonly onReply: ((response: ResponseContextRecord) => boolean) | undefined;
}) {
  const gt = useGT();
  if (!threadRef || !onReply || !rawText.trim()) return null;

  const handleClick = () => {
    const rowEl = document.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(messageId)}"] [data-user-message-body="true"]`,
    );
    const record = buildUserMessageReplyRecord({
      threadRef,
      messageId,
      itemId,
      rawText,
      sourceElement: rowEl,
    });
    if (!record) return;
    onReply(record);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={handleClick}
            aria-label={gt("Reply to this message")}
          />
        }
      >
        <ReplyIcon className="size-3" />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <T>Reply</T>
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * In-bubble card for a reply-only or mid-message user reply reference (where the header
 * above the bubble does not replace the bubble body).
 */
export function MatterInlineUserReplyCard({
  record,
  copyMarkdown,
  leading,
  trailing,
}: {
  readonly record: ResponseContextRecord;
  readonly copyMarkdown: string;
  readonly leading: boolean;
  readonly trailing: boolean;
}) {
  const gt = useGT();
  const jumpToMessage = useJumpToRepliedMessage();
  const authorLabel = gt("you", { $context: "lowercase author tag in a sent reply reference" });
  const excerpt = extractReplyExcerpt(record.citation.text) || record.label;

  return (
    <span
      data-markdown-copy={copyMarkdown}
      className={cn("block", !leading && "mt-[0.65rem]", !trailing && "mb-[0.65rem]")}
    >
      <button
        type="button"
        data-thread-find-ignore=""
        aria-label={gt("Go to replied message from {author}: {excerpt}", {
          author: authorLabel,
          excerpt,
        })}
        onClick={() => jumpToMessage(record)}
        className="block w-full min-w-0 cursor-pointer rounded-lg bg-black/10 px-2.5 py-1.5 text-start text-sm text-muted-foreground! no-underline! wrap-break-word hover:bg-black/14 focus-visible:outline-2 focus-visible:outline-ring dark:bg-black/35 dark:hover:bg-black/50"
      >
        <span className="flex items-center gap-1.5 text-xs font-medium text-foreground/80">
          <ReplyIcon aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{authorLabel}</span>
        </span>
        <span className="block truncate" dir={textDirection(excerpt)}>
          {excerpt}
        </span>
      </button>
    </span>
  );
}
