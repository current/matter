import { isElectron } from "../../../env";
import type { SidebarRouteReveal } from "../routeReveal";
import { SidebarChromeHeader } from "../SidebarChrome";
import { MatterDefaultSidebar } from "./MatterDefaultSidebar";
import { MatterSpacesSidebar } from "./MatterSpacesSidebar";
import { MatterStatusLine } from "./MatterStatusLine";
import { MatterTimelineSidebar } from "./MatterTimelineSidebar";
import type { MatterSidebarLayout } from "./matterSidebarStore";
import { useMatterSidebarModel } from "./useMatterSidebarModel";

/** The fork's custom sidebar bodies under Classic's chrome header. Spaces ends in a status line;
 * Default and Timeline carry their own footers. */
export function MatterCustomSidebarHost({
  layout,
  routeReveal,
}: {
  layout: Exclude<MatterSidebarLayout, "classic">;
  routeReveal?: SidebarRouteReveal | undefined;
}) {
  const model = useMatterSidebarModel();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-matter-sidebar-layout={layout}>
      <SidebarChromeHeader isElectron={isElectron} />
      {layout === "spaces" ? (
        <>
          <MatterSpacesSidebar model={model} />
          <MatterStatusLine />
        </>
      ) : layout === "timeline" ? (
        <MatterTimelineSidebar model={model} routeReveal={routeReveal} />
      ) : (
        <MatterDefaultSidebar model={model} />
      )}
    </div>
  );
}
