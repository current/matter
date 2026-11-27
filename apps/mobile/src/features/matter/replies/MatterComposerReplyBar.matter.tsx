import {
  extractReplyExcerpt,
  resolveReplyRole,
} from "@t3tools/client-runtime/matter/message-reply";
import { useGT } from "gt-react-native";
import { useEffect, useEffectEvent } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import {
  clearMatterReply,
  jumpToMatterReplyTarget,
  subscribeMatterReplyRequests,
  useMatterReply,
} from "./matterReplies";

/**
 * Reply bar docked at the top of the composer's prompt card, as on desktop: who is being replied
 * to and a one-line excerpt (tap to jump to the message), plus an X that cancels the reply.
 */
export function MatterComposerReplyBar(props: {
  readonly draftKey: string;
  readonly onFocusComposer: () => void;
}) {
  const gt = useGT();
  const replyTo = useMatterReply(props.draftKey);
  const focusComposer = useEffectEvent(props.onFocusComposer);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the native editor when a feed Reply action targets this composer
  useEffect(
    () => subscribeMatterReplyRequests(props.draftKey, () => focusComposer()),
    [props.draftKey],
  );
  if (!replyTo) return null;

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

  return (
    <Animated.View
      key={replyTo.contextId}
      entering={FadeIn.duration(150)}
      exiting={FadeOut.duration(120)}
      className="min-h-9 flex-row items-center gap-1.5 border-b border-border-subtle bg-subtle py-0.5 pr-1 pl-3"
    >
      <SymbolView
        name="arrowshape.turn.up.left"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Jump to replied message: {excerpt}", { excerpt })}
        className="min-w-0 flex-1 flex-row items-center gap-1.5 py-1"
        onPress={() => jumpToMatterReplyTarget(replyTo)}
      >
        <Text className="shrink-0 font-t3-medium text-xs text-foreground" numberOfLines={1}>
          {heading}
        </Text>
        {excerpt ? (
          <>
            <Text
              accessible={false}
              importantForAccessibility="no"
              className="text-xs text-foreground-tertiary"
            >
              ·
            </Text>
            <Text className="min-w-0 flex-1 text-xs text-foreground-secondary" numberOfLines={1}>
              {excerpt}
            </Text>
          </>
        ) : null}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={gt("Cancel reply")}
        hitSlop={8}
        className="size-7 items-center justify-center"
        onPress={() => clearMatterReply(props.draftKey)}
      >
        <View accessible={false}>
          <SymbolView
            name="xmark"
            size={11}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </View>
      </Pressable>
    </Animated.View>
  );
}
