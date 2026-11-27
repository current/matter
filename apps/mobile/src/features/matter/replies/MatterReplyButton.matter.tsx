import type { MatterReplyRole } from "@t3tools/client-runtime/matter/message-reply";
import type { EnvironmentId, MessageId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useGT } from "gt-react-native";
import { Pressable, type ColorValue } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { replyToMatterMessage } from "./matterReplies";

/** Reply action in a message's action row: docks a reply to that message in the composer. */
export function MatterReplyButton(props: {
  /** False where the thread's composer can't take a reply (subagent, locked or read-only). */
  readonly enabled: boolean;
  readonly role: MatterReplyRole;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly itemId?: TurnItemId | undefined;
  readonly text: string;
  readonly tintColor: ColorValue;
  readonly buttonSize?: number;
  readonly iconSize?: number;
}) {
  const gt = useGT();
  if (!props.enabled || props.text.trim().length === 0) return null;
  const size = props.buttonSize ?? 28;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.role === "user" ? gt("Reply to this message") : gt("Reply to this response")
      }
      hitSlop={8}
      onPress={() => {
        const started = replyToMatterMessage({
          role: props.role,
          environmentId: props.environmentId,
          threadId: props.threadId,
          messageId: props.messageId,
          itemId: props.itemId,
          text: props.text,
        });
        if (started) void Haptics.selectionAsync();
      }}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <SymbolView
        name="arrowshape.turn.up.left"
        size={props.iconSize ?? 13}
        tintColor={props.tintColor}
        type="monochrome"
      />
    </Pressable>
  );
}
