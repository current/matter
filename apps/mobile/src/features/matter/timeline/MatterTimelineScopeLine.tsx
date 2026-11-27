import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { Pressable, View } from "react-native";

import { Menu } from "../../../components/ui/Menu";
import type { MenuProps } from "../../../components/ui/Menu.types";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "../../home/home-list-filter-menu";

/**
 * The Mac Timeline's scope line in place of upstream's filter chips: the project scope as quiet
 * text with a chevron, and the environment beside it only when there is more than one to pick.
 */
export function MatterTimelineScopeLine(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly gutter: number;
}) {
  const gt = useGT();
  const selectedEnvironment = props.environments.find(
    (environment) => environment.environmentId === props.selectedEnvironmentId,
  );
  const selectedProject = props.projects.find(
    (project) => project.key === props.selectedProjectKey,
  );
  const showEnvironments = props.environments.length > 1 || selectedEnvironment !== undefined;
  return (
    <View
      className={cn(
        "flex-row items-center justify-between pb-1 pt-0.5",
        // Same inset as the section headers below, so the scope reads as their heading.
        props.gutter > 0 ? "px-3" : "px-5",
      )}
    >
      <ScopeMenu
        label={selectedProject?.label ?? gt("All projects")}
        accessibilityLabel={gt("Filter threads by project")}
        active={selectedProject !== undefined}
        actions={[
          {
            id: "all",
            title: gt("All projects"),
            state: props.selectedProjectKey === null ? "on" : "off",
          },
          ...props.projects.map((project) => ({
            id: JSON.stringify(project.key),
            title: project.label,
            state: project.key === props.selectedProjectKey ? ("on" as const) : ("off" as const),
          })),
        ]}
        onSelect={(id) => {
          if (id === "all") props.onProjectChange(null);
          else {
            const project = props.projects.find(
              (candidate) => JSON.stringify(candidate.key) === id,
            );
            if (project) props.onProjectChange(project.key);
          }
        }}
      />
      {showEnvironments ? (
        <ScopeMenu
          quiet
          label={selectedEnvironment?.label ?? gt("All environments")}
          accessibilityLabel={gt("Filter threads by environment")}
          active={selectedEnvironment !== undefined}
          actions={[
            {
              id: "all",
              title: gt("All environments"),
              state: props.selectedEnvironmentId === null ? "on" : "off",
            },
            ...props.environments.map((environment) => ({
              id: JSON.stringify(environment.environmentId),
              title: environment.label,
              state:
                environment.environmentId === props.selectedEnvironmentId
                  ? ("on" as const)
                  : ("off" as const),
            })),
          ]}
          onSelect={(id) => {
            if (id === "all") props.onEnvironmentChange(null);
            else {
              const environment = props.environments.find(
                (candidate) => JSON.stringify(candidate.environmentId) === id,
              );
              if (environment) props.onEnvironmentChange(environment.environmentId);
            }
          }}
        />
      ) : null}
    </View>
  );
}

function ScopeMenu(props: {
  /** The secondary scope (environment) sits a step under the project scope, which heads the list. */
  readonly quiet?: boolean;
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly active: boolean;
  readonly actions: MenuProps["actions"];
  readonly onSelect: (id: string) => void;
}) {
  return (
    <Menu
      title={props.accessibilityLabel}
      actions={props.actions}
      onPressAction={({ nativeEvent }) => props.onSelect(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityValue={{ text: props.label }}
        accessibilityState={{ selected: props.active }}
        className="min-h-8 min-w-0 shrink flex-row items-center gap-1"
        hitSlop={{ top: 6, bottom: 6 }}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Text
          className={cn(
            "shrink font-t3-medium",
            props.quiet ? "text-2xs" : "text-xs",
            props.active
              ? "text-foreground"
              : props.quiet
                ? "text-foreground-tertiary"
                : "text-foreground-muted",
          )}
          numberOfLines={1}
        >
          {props.label}
        </Text>
        <SymbolView
          name="chevron.down"
          size={props.quiet ? 8 : 9}
          weight="semibold"
          type="monochrome"
          tintColorClassName="accent-foreground-tertiary"
        />
      </Pressable>
    </Menu>
  );
}
