import { isElectron } from "../../../env";
import { SidebarChromeFooter, SidebarChromeHeader } from "../SidebarChrome";
import { MattrAttentionInboxSidebar } from "./MattrAttentionInboxSidebar";
import { MattrLayoutSwitcher } from "./MattrSidebarParts";
import { MattrSpacesSidebar } from "./MattrSpacesSidebar";
import type { MattrSidebarLayout } from "./mattrSidebarStore";
import { useMattrSidebarModel } from "./useMattrSidebarModel";

/** The fork's custom sidebar bodies, framed by the same chrome header and footer as Classic. */
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
      <div className="shrink-0 border-t border-sidebar-border/60 pt-1.5">
        <div className="px-2 pb-0.5">
          <MattrLayoutSwitcher />
        </div>
        <SidebarChromeFooter hideVoice />
      </div>
    </div>
  );
}
