import { useRouter } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { XIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";

import { isElectron } from "../env";
import { requestWorkspaceFocus } from "../lib/workspaceFocus";
import { GlobalVoiceInputIndicator } from "./chat/GlobalVoiceInputIndicator";
import { useCloseAppModal } from "./sidebar/mainAppLocation";
import { Button } from "./ui/button";
import { SidebarInset } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

// Layers that own Escape while open. The page surface keeps `data-app-modal` so the
// shortcut guards that skip dialogs still treat it as a page that owns its keys.
const ESCAPE_LAYER_SELECTOR =
  '[role="dialog"]:not([data-app-modal]), [aria-modal="true"]:not([data-app-modal]), [data-slot$="popup"]:not([data-app-modal])';

/**
 * Matter: Settings and Usage as pages in the shell's inset card instead of upstream's floating
 * `AppRouteModal`. The sidebar stays usable; Esc and the close button return to the opener.
 */
export function MatterInsetPage({
  label,
  breadcrumb,
  actions,
  children,
}: {
  label: string;
  breadcrumb: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const closeAppModal = useCloseAppModal();
  const router = useRouter();
  const pageRef = useRef<HTMLElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [openerArea] = useState(() =>
    document.activeElement instanceof HTMLElement
      ? (document.activeElement.closest<HTMLElement>("[data-workspace-area]")?.dataset
          .workspaceArea ?? null)
      : null,
  );

  const close = (viaKeyboard = false) => {
    // Closing unmounts a focused field without a blur, so commit-on-blur rows would drop input.
    blurFocusedWithin(document.querySelector("[data-matter-inset-page]"));
    void closeAppModal();
    if (viaKeyboard && openerArea) requestWorkspaceFocus({ area: openerArea });
  };
  const closeFromKeyboard = useEffectEvent(() => close(true));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the page surface so Esc and shortcuts reach it, not the hidden thread
  useEffect(() => {
    if (!pageRef.current?.contains(document.activeElement)) {
      surfaceRef.current?.focus({ preventScroll: true });
    }
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- router listener that blurs a field before navigation unmounts it
  useEffect(
    () =>
      router.subscribe("onBeforeLoad", ({ pathChanged }) => {
        const focused = document.activeElement;
        if (pathChanged && focused?.matches("input, textarea, [contenteditable]")) {
          blurFocusedWithin(pageRef.current);
        }
      }),
    [router],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window Escape listener; popups that were open when the key went down keep it
  useEffect(() => {
    let armed = false;
    const onCapture = (event: KeyboardEvent) => {
      const target = event.target;
      armed =
        event.key === "Escape" &&
        !event.repeat &&
        !event.isComposing &&
        document.querySelector(ESCAPE_LAYER_SELECTOR) === null &&
        !(
          target instanceof Element &&
          target.closest(`${ESCAPE_LAYER_SELECTOR}, [data-keybinding-capture]`)
        ) &&
        (target === document.body ||
          (target instanceof Node && pageRef.current?.contains(target) === true));
    };
    const onBubble = (event: KeyboardEvent) => {
      if (!armed || event.key !== "Escape") return;
      armed = false;
      if (event.defaultPrevented) return;
      event.preventDefault();
      closeFromKeyboard();
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble);
    };
  }, []);

  return (
    <SidebarInset
      ref={pageRef}
      data-matter-inset-page=""
      className="h-svh min-h-0 overflow-hidden overscroll-y-none md:h-dvh"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b">
        {breadcrumb}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          {actions}
          <MatterInsetPageClose onClose={() => close()} />
        </div>
      </WorkspacePageHeader>
      <div
        ref={surfaceRef}
        role="region"
        aria-label={label}
        data-app-modal=""
        tabIndex={-1}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      >
        {children}
        <GlobalVoiceInputIndicator />
      </div>
    </SidebarInset>
  );
}

function blurFocusedWithin(container: HTMLElement | null) {
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && container?.contains(focused)) focused.blur();
}

function MatterInsetPageClose({ onClose }: { onClose: () => void }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button size="icon-sm" variant="ghost" aria-label={gt("Close")} onClick={onClose} />
        }
      >
        <XIcon />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        <T>Close (Esc)</T>
      </TooltipPopup>
    </Tooltip>
  );
}
