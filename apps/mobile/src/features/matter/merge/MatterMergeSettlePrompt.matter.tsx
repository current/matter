import {
  resolveAutoSettleOnMerge,
  resolveMergeSettlePrompt,
} from "@t3tools/client-runtime/matter/merge-settle-prompt";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ServerConfig } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Animated, { FadeInDown, FadeOut } from "react-native-reanimated";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { useNowMinuteMs } from "../../../lib/clock";
import { cn } from "../../../lib/cn";
import { scopedThreadKey } from "../../../lib/scopedEntities";
import { useThreadListActions } from "../../home/useThreadListActions";
import { pullRequestStatus } from "../../pull-requests/pullRequestStatus";
import {
  dismissMatterMergeSettlePrompt,
  useMatterMergeSettleDismissals,
} from "./matterMergeSettleStore";

/** Matter: asks whether to settle a thread whose PR merged, when the server won't do it itself. */
export function MatterMergeSettlePrompt(props: {
  readonly thread: EnvironmentThreadShell;
  readonly serverConfig: ServerConfig | null;
  readonly canOperateThread: boolean;
}) {
  const gt = useGT();
  const nowMs = useNowMinuteMs();
  const { dismissals, loaded } = useMatterMergeSettleDismissals();
  const { settleThread } = useThreadListActions();
  const [settling, setSettling] = useState(false);
  const { thread, serverConfig } = props;
  const threadKey = scopedThreadKey(thread.environmentId, thread.id);
  const prNumber =
    serverConfig === null || !loaded || !props.canOperateThread
      ? null
      : resolveMergeSettlePrompt({
          thread,
          threadKey,
          autoSettleOnMerge: resolveAutoSettleOnMerge(serverConfig.settings, thread.projectId),
          dismissals,
          nowMs,
        });
  if (prNumber === null) return null;

  const merged = pullRequestStatus({ state: "merged", isDraft: false });
  const settle = () => {
    if (settling) return;
    setSettling(true);
    void settleThread(thread).finally(() => setSettling(false));
  };

  return (
    <Animated.View
      accessibilityRole="summary"
      entering={FadeInDown.duration(180)}
      exiting={FadeOut.duration(120)}
      className="mx-3 mb-2 gap-2.5 rounded-[18px] border border-border bg-card p-3.5"
      style={{ borderCurve: "continuous" }}
    >
      <View className="flex-row items-start gap-2.5">
        <View
          className={cn(
            "h-6 w-6 shrink-0 items-center justify-center rounded-[7px]",
            merged.background,
          )}
        >
          <SymbolView name={merged.icon} size={13} tintColorClassName={merged.tint} />
        </View>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text className="font-t3-medium text-sm text-foreground">
            {gt("Pull request #{number} merged", { number: prNumber })}
          </Text>
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {gt("Settle this thread? It moves to Settled.")}
          </Text>
        </View>
      </View>
      <View className="flex-row items-center justify-end gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Keep this thread")}
          hitSlop={6}
          onPress={() => dismissMatterMergeSettlePrompt(threadKey, prNumber)}
          className="h-8 items-center justify-center rounded-full bg-grouped-card px-3.5 active:opacity-75"
        >
          <Text className="font-t3-medium text-sm text-foreground">{gt("Keep")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: settling, busy: settling }}
          disabled={settling}
          hitSlop={6}
          onPress={settle}
          className={cn(
            "h-8 items-center justify-center rounded-full px-3.5 active:opacity-80",
            settling ? "bg-grouped-card" : "bg-prominent-action",
          )}
        >
          <Text
            className={cn(
              "font-t3-medium text-sm",
              settling ? "text-foreground-muted" : "text-prominent-action-foreground",
            )}
          >
            {gt("Settle")}
          </Text>
        </Pressable>
      </View>
    </Animated.View>
  );
}
