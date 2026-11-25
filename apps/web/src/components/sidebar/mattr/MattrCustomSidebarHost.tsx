import { isElectron } from "../../../env";
import { SidebarChromeHeader } from "../SidebarChrome";
import { MattrAttentionInboxSidebar } from "./MattrAttentionInboxSidebar";
import { MattrSpacesSidebar } from "./MattrSpacesSidebar";
import { MattrStatusLine } from "./MattrStatusLine";
import type { MattrSidebarLayout } from "./mattrSidebarStore";
import { useMattrSidebarModel } from "./useMattrSidebarModel";

/** The fork's custom sidebar bodies, under Classic's chrome header and above one status line. */
export function MattrCustomSidebarHost({
  layout,
}: {
  layout: Exclude<MattrSidebarLayout, "classic">;
}) {
  const model = useMattrSidebarModel();
  return (
    <div className="relative flex min-h-0 flex-1 flex-col" data-mattr-sidebar-layout={layout}>
      <SidebarChromeHeader isElectron={isElectron} />
      {layout === "spaces" ? (
        <MattrSpacesSidebar model={model} />
      ) : (
        <MattrAttentionInboxSidebar model={model} />
      )}
      <MattrStatusLine />
    </div>
  );
}
