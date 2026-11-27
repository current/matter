import {
  extractReplyExcerpt,
  resolveReplyRole,
} from "@t3tools/client-runtime/matter/message-reply";
import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { jumpToMatterReplyTarget, matterLeadingReply } from "./matterReplies";

/** Compact reference above a sent user bubble that leads with a reply; tap jumps to its target. */
export function MatterSentReplyHeader(props: {
  readonly text: string;
  readonly context: OrchestrationMessageContext | undefined;
}) {
  const gt = useGT();
  const record = matterLeadingReply(props.text, props.context);
  if (!record) return null;
  const subagentTitles = record.subagents?.length
    ? record.subagents.map((subagent) => subagent.title).join(", ")
    : null;
  const author =
    subagentTitles ??
    (resolveReplyRole(record) === "user"
      ? gt("you", { $context: "lowercase author tag in a sent reply reference" })
      : gt("assistant", { $context: "lowercase author tag in a sent reply reference" }));
  const excerpt = extractReplyExcerpt(record.citation.text) || record.label;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("Go to replied message from {author}: {excerpt}", {
        author,
        excerpt,
      })}
      hitSlop={4}
      className="mr-1 mb-1 max-w-[80%] min-w-0 flex-row items-center gap-1 px-1.5 py-0.5"
      style={({ pressed }) => ({ opacity: pressed ? 0.52 : 1 })}
      onPress={() => jumpToMatterReplyTarget(record)}
    >
      <SymbolView
        name="arrowshape.turn.up.left"
        size={10}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
      <Text
        className="shrink-0 font-t3-medium text-2xs text-foreground-secondary"
        numberOfLines={1}
      >
        {author}
      </Text>
      {excerpt ? (
        <>
          <Text
            accessible={false}
            importantForAccessibility="no"
            className="text-2xs text-foreground-tertiary"
          >
            ·
          </Text>
          <Text className="min-w-0 shrink text-2xs text-foreground-secondary" numberOfLines={1}>
            {excerpt}
          </Text>
        </>
      ) : null}
    </Pressable>
  );
}
