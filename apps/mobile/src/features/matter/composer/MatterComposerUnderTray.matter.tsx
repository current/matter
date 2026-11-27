import type {
  ManagedPolicySummary,
  ProviderRuntimeModeLimit,
  RuntimeMode,
} from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { Menu } from "../../../components/ui/Menu";
import { cn } from "../../../lib/cn";
import {
  RUNTIME_MODE_CHOICES,
  runtimeModeChoicesForSupportedModes,
  withManagedRuntimeModeLimits,
  withProviderRuntimeModeLimits,
} from "../../threads/thread-settings-options";
import { formatMatterUnderTrayWorkspaceLabel } from "./matterComposerLogic";

export interface MatterComposerUnderTrayProps {
  readonly projectTitle: string;
  readonly onPressProject?: () => void;
  readonly workspaceMode: "local" | "worktree";
  readonly worktreePath: string | null;
  readonly canToggleWorkspace?: boolean;
  readonly onToggleWorkspace?: () => void;
  readonly runtimeMode: RuntimeMode;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode> | undefined;
  readonly managedPolicy?: ManagedPolicySummary | undefined;
  readonly providerRuntimeModeLimits?: ReadonlyArray<ProviderRuntimeModeLimit> | undefined;
  readonly canChangeRuntimeMode: boolean;
  readonly onChangeRuntimeMode: (mode: RuntimeMode) => void;
  readonly branchLabel: string | null;
  readonly onPressBranch?: () => void;
  readonly branchDisabled?: boolean;
}

/**
 * Matter's Shelf under-tray row: project, Local/Worktree, permissions in amber, and branch pinned
 * to the right edge. Mirrors `matter/composer.css` on both new-chat drafts and active threads.
 */
export function MatterComposerUnderTray(props: MatterComposerUnderTrayProps) {
  const gt = useGT();
  const messages = useMessages();

  const workspaceLabel = formatMatterUnderTrayWorkspaceLabel(
    { workspaceMode: props.workspaceMode, worktreePath: props.worktreePath },
    messages,
  );
  const isWorktree = props.workspaceMode === "worktree" || props.worktreePath !== null;

  const baseChoices = runtimeModeChoicesForSupportedModes(props.supportedRuntimeModes);
  const runtimeModeChoices = withProviderRuntimeModeLimits(
    withManagedRuntimeModeLimits(baseChoices, [props.managedPolicy], messages),
    props.providerRuntimeModeLimits,
    messages,
  );
  const currentRuntimeChoice =
    RUNTIME_MODE_CHOICES.find((choice) => choice.mode === props.runtimeMode) ??
    RUNTIME_MODE_CHOICES[RUNTIME_MODE_CHOICES.length - 1]!;
  const runtimeModeLabel = messages(currentRuntimeChoice.label);

  const projectContent = (
    <View className="max-w-[116px] shrink-0 flex-row items-center gap-1.5 px-1.5 py-1">
      <SymbolView
        name="folder"
        size={12}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <Text className="shrink text-2xs font-t3-medium text-foreground" numberOfLines={1}>
        {props.projectTitle}
      </Text>
    </View>
  );

  const workspaceContent = (
    <View className="shrink-0 flex-row items-center gap-1 px-1.5 py-1">
      <SymbolView
        name={isWorktree ? "arrow.branch" : "laptopcomputer"}
        size={12}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
        {workspaceLabel}
      </Text>
    </View>
  );

  const permissionsTrigger = (
    <Pressable
      accessibilityLabel={gt("Permissions: {mode}", { mode: runtimeModeLabel })}
      accessibilityRole="button"
      accessibilityState={{ disabled: !props.canChangeRuntimeMode }}
      disabled={!props.canChangeRuntimeMode}
      hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
      className={cn(
        "shrink-0 flex-row items-center gap-1 rounded-[7px] px-1.5 py-1 active:opacity-70",
        !props.canChangeRuntimeMode && "opacity-60",
      )}
    >
      <Text className="text-2xs font-t3-medium text-warning-foreground" numberOfLines={1}>
        {runtimeModeLabel}
      </Text>
    </Pressable>
  );

  const branchContent = props.branchLabel ? (
    <View className="max-w-[126px] shrink-0 flex-row items-center gap-1 px-1.5 py-1">
      <SymbolView
        name="arrow.triangle.branch"
        size={12}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
      <Text className="shrink text-2xs text-foreground-muted" numberOfLines={1}>
        {props.branchLabel}
      </Text>
    </View>
  ) : null;

  return (
    <View className="min-h-[34px] justify-center px-1">
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
        }}
      >
        {props.onPressProject ? (
          <Pressable
            accessibilityHint={gt("Opens the project picker")}
            accessibilityLabel={gt("Project: {project}", { project: props.projectTitle })}
            accessibilityRole="button"
            hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            onPress={props.onPressProject}
            className="rounded-[7px] active:opacity-70"
          >
            {projectContent}
          </Pressable>
        ) : (
          projectContent
        )}

        {props.canToggleWorkspace && props.onToggleWorkspace ? (
          <Pressable
            accessibilityHint={
              props.workspaceMode === "local"
                ? gt("Switches to a new worktree")
                : gt("Switches to the current checkout")
            }
            accessibilityLabel={workspaceLabel}
            accessibilityRole="button"
            hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
            onPress={props.onToggleWorkspace}
            className="rounded-[7px] active:opacity-70"
          >
            {workspaceContent}
          </Pressable>
        ) : (
          workspaceContent
        )}

        {props.canChangeRuntimeMode ? (
          <Menu
            title={gt("Permissions")}
            actions={runtimeModeChoices.map((choice) => ({
              id: choice.mode,
              title: messages(choice.label),
              subtitle: choice.disabledReason ?? messages(choice.description),
              attributes: choice.disabledReason ? { disabled: true } : undefined,
              state: choice.mode === props.runtimeMode ? ("on" as const) : ("off" as const),
            }))}
            onPressAction={({ nativeEvent }) => {
              const next = nativeEvent.event as RuntimeMode;
              const picked = runtimeModeChoices.find((choice) => choice.mode === next);
              if (picked && picked.disabledReason === undefined && next !== props.runtimeMode) {
                props.onChangeRuntimeMode(next);
              }
            }}
          >
            {permissionsTrigger}
          </Menu>
        ) : (
          permissionsTrigger
        )}

        {branchContent ? (
          <View className="ml-auto shrink-0">
            {props.onPressBranch ? (
              <Pressable
                accessibilityLabel={gt("Branch: {branch}", { branch: props.branchLabel ?? "" })}
                accessibilityRole="button"
                accessibilityState={{ disabled: props.branchDisabled }}
                disabled={props.branchDisabled}
                hitSlop={{ top: 6, bottom: 6, left: 2, right: 2 }}
                onPress={props.onPressBranch}
                className={cn(
                  "rounded-[7px] active:opacity-70",
                  props.branchDisabled && "opacity-50",
                )}
              >
                {branchContent}
              </Pressable>
            ) : (
              branchContent
            )}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}
