import {
  type ComposerContextRecord,
  type EnvironmentId,
  type MessageId,
  type OrchestrationMessageContext,
  type ResponseContextRecord,
  type ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  assistantCitationsToPlainText,
  createAssistantTextSelector,
  splitsSurrogatePair,
} from "@t3tools/shared/assistantCitations";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  replaceComposerContextReferences,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

import { prependKeepingGoalCommand } from "./interactionMode.ts";

export type MatterReplyRole = "user" | "assistant";

export const MATTER_REPLY_EXCERPT_MAX_CHARS = 180;
/** How much of the target's opening travels in the citation, as on web. */
const REPLY_OPENING_LENGTH = 300;
const REPLY_LABEL_MAX_CHARS = 64;

/** Plain text of a message for reply excerpts: nested reply cards drop, other chips keep labels. */
export function stripReplyMarkdownToPlainText(input: string): string {
  let text = replaceComposerContextReferences(input, (reference) =>
    reference.kind === "response" ? "" : reference.label,
  );
  text = assistantCitationsToPlainText(text);
  text = text.replace(/```[^\n]*\n?([\s\S]*?)```/g, " $1 ");
  text = text.replace(/~~~[^\n]*\n?([\s\S]*?)~~~/g, " $1 ");
  text = text.replace(/`+([^`]+)`+/g, "$1");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
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
  text = text
    .replace(/(\*\*|__|~~)(.*?)\1/g, "$2")
    .replace(/(^|[\s([{"'])\*([^*\n]+)\*(?=$|[\s.,!?;:)\]}"'])/g, "$1$2")
    .replace(/(^|[\s([{"'])_([^_\n]+)_(?=$|[\s.,!?;:)\]}"'])/g, "$1$2");
  return text.replace(/\s+/g, " ").trim();
}

/** A single-line excerpt, capped without splitting a surrogate pair. */
export function extractReplyExcerpt(
  rawText: string,
  maxChars: number = MATTER_REPLY_EXCERPT_MAX_CHARS,
): string {
  const plain = stripReplyMarkdownToPlainText(rawText);
  if (plain.length === 0 || maxChars <= 0) return "";
  if (plain.length <= maxChars) return plain;
  let end = Math.max(1, maxChars - 1);
  if (splitsSurrogatePair(plain, end)) end -= 1;
  const sliced = plain.slice(0, end).replace(/[\s,;:–—-]+$/u, "");
  return `${sliced || plain.slice(0, end)}…`;
}

export function resolveReplyRole(record: ResponseContextRecord): MatterReplyRole {
  return record.role === "user" ? "user" : "assistant";
}

function isResponseContextRecord(record: ComposerContextRecord): record is ResponseContextRecord {
  return record.kind === "response" && "citation" in record;
}

export interface ExtractedLeadingReply {
  readonly record: ResponseContextRecord;
  readonly bodyText: string;
}

/**
 * Splits a reply card that leads a user message from its body, so the feed can show the reference
 * above the bubble. A reply-only message stays whole so its bubble is never blank.
 */
export function extractLeadingReplyReference(
  text: string,
  records: ReadonlyMap<string, ComposerContextRecord> | ReadonlyArray<ComposerContextRecord>,
): ExtractedLeadingReply | null {
  const trimmedStart = text.trimStart();
  const leadingOffset = text.length - trimmedStart.length;
  const firstReference = collectComposerContextReferences(trimmedStart)[0];
  if (!firstReference || firstReference.start !== 0 || firstReference.kind !== "response") {
    return null;
  }
  const candidate =
    "get" in records
      ? records.get(firstReference.contextId)
      : records.find((record) => record.contextId === firstReference.contextId);
  if (!candidate || !isResponseContextRecord(candidate)) return null;
  const remainder = text.slice(leadingOffset + firstReference.end).replace(/^[ \t]+/, "");
  const bodyText = remainder.replace(/^\r?\n/, "");
  if (bodyText.trim().length === 0) return null;
  return { record: candidate, bodyText };
}

function replyLabel(text: string): string {
  const end = splitsSurrogatePair(text, REPLY_LABEL_MAX_CHARS)
    ? REPLY_LABEL_MAX_CHARS - 1
    : REPLY_LABEL_MAX_CHARS;
  return sanitizeComposerContextLabel(text.slice(0, end), "response");
}

/**
 * The `ResponseContextRecord` web builds for a Reply: one record per message, so replying to it
 * again reuses the same reference. Clients without a rendered DOM cite the plain-text opening.
 */
export function buildMatterReplyRecord(input: {
  readonly role: MatterReplyRole;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly itemId?: TurnItemId | undefined;
  readonly text: string;
  readonly subagents?: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly title: string;
    readonly environmentId?: EnvironmentId;
  }>;
}): ResponseContextRecord | null {
  const plain = stripReplyMarkdownToPlainText(input.text);
  const source = plain || input.text;
  const rawStart = source.length - source.trimStart().length;
  let rawEnd = Math.min(source.trimEnd().length, rawStart + REPLY_OPENING_LENGTH);
  if (splitsSurrogatePair(source, rawEnd)) rawEnd -= 1;
  const opening = createAssistantTextSelector(source, rawStart, rawEnd);
  if (!opening) return null;
  const citation = {
    version: 1 as const,
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: input.messageId,
    ...opening,
  };
  const subagents = input.subagents ?? [];
  return {
    version: 1,
    kind: "response",
    contextId: toKindScopedComposerContextId("response", input.messageId),
    label: replyLabel(citation.text),
    role: input.role,
    citation,
    itemId: input.itemId ?? TurnItemId.make(input.messageId),
    ...(subagents.length > 0
      ? {
          subagents: subagents.slice(0, 20).map(({ title, ...subagent }) => ({
            ...subagent,
            title: sanitizeComposerContextLabel(title, "response"),
          })),
        }
      : {}),
  };
}

/**
 * Folds a pending reply into an outgoing message the way web sends it: the reply card leads the
 * text (after a leading `/goal`), and its record joins the message context. Text that already
 * points at that response keeps its one reference.
 */
export function withMatterReply(
  message: { readonly text: string; readonly context: OrchestrationMessageContext | undefined },
  replyTo: ResponseContextRecord | null,
): { text: string; context: OrchestrationMessageContext | undefined } {
  if (!replyTo) return { text: message.text, context: message.context };
  const referenced = collectComposerContextReferences(message.text).some(
    (reference) => reference.contextId === replyTo.contextId,
  );
  const text = referenced
    ? message.text
    : prependKeepingGoalCommand(
        message.text,
        formatComposerContextReference({
          kind: "response",
          contextId: replyTo.contextId,
          label: replyTo.label,
        }),
      );
  const records = (message.context?.records ?? []).filter(
    (record) => record.contextId !== replyTo.contextId,
  );
  return { text, context: { version: 1, records: [...records, replyTo] } };
}
