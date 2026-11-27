import {
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
  projectComposerContextForProvider,
} from "@t3tools/shared/composerContextReferences";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMatterReplyRecord,
  extractLeadingReplyReference,
  extractReplyExcerpt,
  MATTER_REPLY_EXCERPT_MAX_CHARS,
  resolveReplyRole,
  withMatterReply,
} from "./messageReply.ts";

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);
const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");

function reply(role: "user" | "assistant", text: string, messageId = "msg-1") {
  const record = buildMatterReplyRecord({
    role,
    environmentId,
    threadId,
    messageId: MessageId.make(messageId),
    text,
  });
  if (!record) throw new Error("expected a reply record");
  return record;
}

function token(record: ReturnType<typeof reply>) {
  return formatComposerContextReference({
    kind: "response",
    contextId: record.contextId,
    label: record.label,
  });
}

describe("extractReplyExcerpt", () => {
  it("strips markdown into one plain line", () => {
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
    expect(extractReplyExcerpt(markdown)).toBe(
      "Summary of changes Important: see router.ts and handleReply() for details. Added bold, italic, and old items Second item with diagram const value = compute(42);",
    );
  });

  it("drops nested reply cards and keeps other context labels", () => {
    expect(
      extractReplyExcerpt(
        "[Earlier answer](t3-context://v1/response/response_msg1) Please check [App.tsx](t3-context://v1/mention/mention_1) next",
      ),
    ).toBe("Please check App.tsx next");
  });

  it("caps without splitting a surrogate pair", () => {
    const excerpt = extractReplyExcerpt(`${"a".repeat(178)}😀 trailing words`);
    expect(excerpt).toBe(`${"a".repeat(178)}…`);
    expect(excerpt.length).toBeLessThanOrEqual(MATTER_REPLY_EXCERPT_MAX_CHARS);
  });

  it("is empty for blank or reply-only text", () => {
    expect(extractReplyExcerpt("  \n\t ")).toBe("");
    expect(extractReplyExcerpt("[old](t3-context://v1/response/response_1)  ")).toBe("");
  });
});

describe("buildMatterReplyRecord", () => {
  it("builds a valid record that cites the plain-text opening", () => {
    const record = reply("assistant", "**Done.** I updated `router.ts`.", "msg-a");
    expect(record).toMatchObject({
      kind: "response",
      contextId: "response_msg-a",
      role: "assistant",
      itemId: TurnItemId.make("msg-a"),
      citation: { environmentId, threadId, messageId: "msg-a", text: "Done. I updated router.ts." },
    });
    expect(resolveReplyRole(record)).toBe("assistant");
    expect(() => decodeMessageContext({ version: 1, records: [record] })).not.toThrow();
  });

  it("keeps the item id and quotes a user's own words, not an earlier reply card", () => {
    const record = buildMatterReplyRecord({
      role: "user",
      environmentId,
      threadId,
      messageId: MessageId.make("msg-u"),
      itemId: TurnItemId.make("item-u"),
      text: "[prev](t3-context://v1/response/response_old) Check **src/index.ts** please",
    });
    expect(record?.itemId).toBe("item-u");
    expect(record?.citation.text).toBe("Check src/index.ts please");
    expect(resolveReplyRole(record!)).toBe("user");
  });

  it("returns null for a message with no text", () => {
    expect(
      buildMatterReplyRecord({
        role: "assistant",
        environmentId,
        threadId,
        messageId: MessageId.make("msg-empty"),
        text: "   ",
      }),
    ).toBeNull();
  });
});

describe("withMatterReply", () => {
  it("leads the text with the reply card and adds its record, as web sends it", () => {
    const record = reply("assistant", "Here is the plan.");
    const sent = withMatterReply({ text: "Looks good, go ahead", context: undefined }, record);
    expect(sent.text).toBe(`${token(record)} Looks good, go ahead`);
    expect(sent.context).toEqual({ version: 1, records: [record] });
    const projected = projectComposerContextForProvider({
      text: sent.text,
      records: decodeMessageContext(sent.context).records,
    });
    expect(projected).toContain("Here is the plan.");
  });

  it("keeps `/goal` first", () => {
    const record = reply("user", "Ship the port");
    expect(withMatterReply({ text: "/goal finish it", context: undefined }, record).text).toBe(
      `/goal ${token(record)} finish it`,
    );
  });

  it("keeps one reference when the text already points at that response", () => {
    const record = reply("assistant", "Answer");
    const text = `See ${token(record)} again`;
    const sent = withMatterReply({ text, context: { version: 1, records: [record] } }, record);
    expect(sent.text).toBe(text);
    expect(collectComposerContextReferences(sent.text)).toHaveLength(1);
    expect(sent.context?.records).toHaveLength(1);
  });

  it("passes the message through without a reply", () => {
    const message = { text: "hi", context: undefined };
    expect(withMatterReply(message, null)).toEqual(message);
  });
});

describe("extractLeadingReplyReference", () => {
  it("splits a leading reply card from the body", () => {
    const record = reply("user", "Can we refactor the composer?");
    expect(
      extractLeadingReplyReference(`${token(record)} Yes, let's do that next`, [record]),
    ).toEqual({ record, bodyText: "Yes, let's do that next" });
  });

  it("leaves reply-only and mid-message references in the bubble", () => {
    const record = reply("user", "First message");
    const records = new Map([[record.contextId, record]]);
    expect(extractLeadingReplyReference(`${token(record)}   `, records)).toBeNull();
    expect(extractLeadingReplyReference(`Follow up on ${token(record)}`, records)).toBeNull();
  });

  it("ignores a reference without its record", () => {
    const record = reply("assistant", "Answer");
    expect(extractLeadingReplyReference(`${token(record)} body`, [])).toBeNull();
  });
});
