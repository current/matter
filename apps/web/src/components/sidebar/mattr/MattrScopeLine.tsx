import { useGT } from "gt-react";
import { ChevronsUpDownIcon, InboxIcon, LayoutGridIcon } from "lucide-react";

import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../../ui/menu";
import { useMattrSidebarLayout } from "./mattrSidebarStore";

export interface MattrScopeProject {
  readonly key: string;
  readonly name: string;
  readonly liveCount?: number | undefined;
}

const ALL_PROJECTS = "__all__";

/**
 * One quiet line that names what the rail shows ("Inbox · All projects") and opens a menu to
 * switch layout or slice the Inbox to a project, in place of a permanent switcher pill.
 */
export function MattrScopeLine({
  projects,
  projectFilter,
  onProjectFilterChange,
}: {
  projects?: ReadonlyArray<MattrScopeProject>;
  projectFilter?: string | null;
  onProjectFilterChange?: (key: string | null) => void;
}) {
  const gt = useGT();
  const [layout, setLayout] = useMattrSidebarLayout();
  const isInbox = layout !== "spaces";
  const filteredName =
    projectFilter == null
      ? null
      : (projects?.find((project) => project.key === projectFilter)?.name ?? null);
  const scopeLabel = filteredName ?? gt("All projects");
  const showProjects = isInbox && projects !== undefined && projects.length > 1;

  return (
    <div className="shrink-0 px-2 pb-0.5">
      <Menu>
        <MenuTrigger
          render={
            <button
              type="button"
              aria-label={
                isInbox
                  ? gt("Sidebar view: Inbox, {scope}", { scope: scopeLabel })
                  : gt("Sidebar view: Spaces")
              }
              className="flex h-6.5 w-full cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-sidebar-muted-foreground outline-hidden ring-ring transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset data-popup-open:bg-sidebar-row-active [&_svg]:size-3.5 [&_svg]:shrink-0"
            />
          }
        >
          {isInbox ? <InboxIcon aria-hidden /> : <LayoutGridIcon aria-hidden />}
          <span className="shrink-0 font-semibold text-sidebar-foreground">
            {isInbox ? gt("Inbox") : gt("Spaces")}
          </span>
          {isInbox ? <span className="min-w-0 truncate">· {scopeLabel}</span> : null}
          <ChevronsUpDownIcon aria-hidden className="ml-auto size-3! opacity-75" />
        </MenuTrigger>
        <MenuPopup align="start">
          <MenuGroup>
            <MenuGroupLabel>{gt("View")}</MenuGroupLabel>
            <MenuRadioGroup
              value={isInbox ? "inbox" : "spaces"}
              onValueChange={(value) => setLayout(value === "spaces" ? "spaces" : "inbox")}
            >
              <MenuRadioItem closeOnClick value="inbox">
                {gt("Inbox")}
              </MenuRadioItem>
              <MenuRadioItem closeOnClick value="spaces">
                {gt("Spaces")}
              </MenuRadioItem>
            </MenuRadioGroup>
          </MenuGroup>
          {showProjects ? (
            <>
              <MenuSeparator />
              <MenuGroup>
                <MenuGroupLabel>{gt("Projects")}</MenuGroupLabel>
                <MenuRadioGroup
                  value={projectFilter ?? ALL_PROJECTS}
                  onValueChange={(value) =>
                    onProjectFilterChange?.(value === ALL_PROJECTS ? null : String(value))
                  }
                >
                  <MenuRadioItem closeOnClick value={ALL_PROJECTS}>
                    {gt("All projects")}
                  </MenuRadioItem>
                  {projects.map((project) => (
                    <MenuRadioItem closeOnClick key={project.key} value={project.key}>
                      {project.name}
                      {project.liveCount ? <MenuShortcut>{project.liveCount}</MenuShortcut> : null}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuGroup>
            </>
          ) : null}
        </MenuPopup>
      </Menu>
    </div>
  );
}
