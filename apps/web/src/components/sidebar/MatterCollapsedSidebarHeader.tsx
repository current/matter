import { useEffect, useRef } from "react";

import { isElectron } from "../../env";
import { useSidebar } from "../ui/sidebar";
import { SidebarChromeHeader } from "./SidebarChrome";

// Covers the sidebar slide plus the chat's re-layout once it lands (matter/shell.css).
const SIDEBAR_SETTLE_MS = 800;

/**
 * Matter shell: the sidebar's titlebar row stays on the window frame above the page card when the
 * sidebar is closed, like a browser's toolbar. The closed sidebar is inert, so its own row can't.
 * It stays mounted while open so matter/shell.css can hold it in place until the sidebar's own
 * row has slid in.
 */
export function MatterCollapsedSidebarHeader() {
  const { isMobile, open } = useSidebar();
  const headerRef = useRef<HTMLDivElement>(null);
  const previousOpen = useRef(open);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- marks the layout wrapper for a moment after a toggle, so shell.css animates the chat's shift only then and never lags a resize
  useEffect(() => {
    if (previousOpen.current === open) return;
    previousOpen.current = open;
    const wrapper = headerRef.current?.closest<HTMLElement>("[data-slot='sidebar-wrapper']");
    if (!wrapper) return;
    wrapper.dataset.matterSettling = "";
    const timer = window.setTimeout(() => delete wrapper.dataset.matterSettling, SIDEBAR_SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      delete wrapper.dataset.matterSettling;
    };
  }, [open]);
  if (isMobile) return null;
  return (
    <div
      ref={headerRef}
      className="fixed top-0 left-0 z-40 w-(--sidebar-width)"
      data-matter-collapsed-header=""
      data-state={open ? "open" : "closed"}
      inert={open}
    >
      <SidebarChromeHeader isElectron={isElectron} />
    </div>
  );
}
