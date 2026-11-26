import { isElectron } from "../../../env";
import type { SidebarRouteReveal } from "../routeReveal";
import { SidebarChromeHeader } from "../SidebarChrome";
import { MattrDefaultSidebar } from "./MattrDefaultSidebar";
import { MattrSpacesSidebar } from "./MattrSpacesSidebar";
import { MattrStatusLine } from "./MattrStatusLine";
import { MattrTimelineSidebar } from "./MattrTimelineSidebar";
import type { MattrSidebarLayout } from "./mattrSidebarStore";
import { useMattrSidebarModel } from "./useMattrSidebarModel";

/** The fork's custom sidebar bodies under Classic's chrome header. Spaces ends in a status line;
 * Default and Timeline carry their own footers. */
export function MattrCustomSidebarHost({
  layout,
  routeReveal,
}: {
  layout: Exclude<MattrSidebarLayout, "classic">;
  routeReveal?: SidebarRouteReveal | undefined;
}) {
  const model = useMattrSidebarModel();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-mattr-sidebar-layout={layout}>
      <SidebarChromeHeader isElectron={isElectron} />
      {layout === "spaces" ? (
        <>
          <MattrSpacesSidebar model={model} />
          <MattrStatusLine />
        </>
      ) : layout === "timeline" ? (
        <MattrTimelineSidebar model={model} routeReveal={routeReveal} />
      ) : (
        <MattrDefaultSidebar model={model} />
      )}
    </div>
  );
}
