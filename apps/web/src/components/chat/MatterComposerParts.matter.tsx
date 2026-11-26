import { T, useGT } from "gt-react";
import { FolderIcon, PlusIcon } from "lucide-react";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";

import { shouldShowComposerContextStrip } from "../BranchToolbar.logic";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The final-choice composer's attach control: a plus, where upstream draws a paperclip. */
export function MatterComposerAttachButton({
  onOpenPicker,
}: {
  readonly onOpenPicker: () => void;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            data-matter-composer-attach=""
            onPointerDown={(event) => event.preventDefault()}
            onClick={onOpenPicker}
            aria-label={gt("Attach files")}
          />
        }
      >
        <PlusIcon />
      </TooltipTrigger>
      <TooltipPopup>
        <T>Attach files</T>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The project name leading the composer's under-tray. */
export function MatterComposerProjectLabel({ title }: { readonly title: string }) {
  return (
    <span data-matter-composer-project="">
      <FolderIcon aria-hidden="true" />
      <span data-matter-composer-project-name="">{title}</span>
    </span>
  );
}

/**
 * Unifies the under-tray across new-chat drafts and active threads for real projects, while
 * collapsing the outer cradle cleanly when a thread has no project (or in scratch active threads).
 */
export function shouldShowMatterComposerContextStrip(input: {
  readonly embedded: boolean;
  readonly hasActiveProject: boolean;
  readonly isScratchProject: boolean;
  readonly isDraftHeroState: boolean;
  readonly showProviderSubagentBar: boolean;
  readonly persistInActiveThreads: boolean;
  readonly isGitRepo: boolean;
  readonly showEnvironmentIndicator: boolean;
}): boolean {
  return shouldShowComposerContextStrip({
    isDraftHeroState:
      input.isDraftHeroState || (!input.isScratchProject && input.persistInActiveThreads),
    persistInActiveThreads: input.persistInActiveThreads,
    hasActiveProject: !input.embedded && input.hasActiveProject && !input.showProviderSubagentBar,
    isGitRepo: input.isGitRepo,
    showEnvironmentIndicator: input.showEnvironmentIndicator,
  });
}

/** Solid macOS-grade microphone glyph sized optically for the 28px composer controls. */
export function MatterDictateIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      aria-hidden="true"
      data-matter-icon="dictate"
      className={className}
    >
      <rect x="5.75" y="1.75" width="4.5" height="7.5" rx="2.25" fill="currentColor" />
      <path
        d="M3.5 7.5a4.5 4.5 0 0 0 9 0"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path
        d="M8 12v2.25M5.75 14.25h4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Crisp 5-bar solid waveform glyph for Voice Mode, avoiding thin-stroke crowding at 15px. */
export function MatterVoiceModeIcon({ className }: { readonly className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="15"
      height="15"
      fill="none"
      aria-hidden="true"
      data-matter-icon="voice-mode"
      className={className}
    >
      <rect x="1.675" y="6" width="1.65" height="4" rx="0.825" fill="currentColor" />
      <rect x="4.425" y="3.75" width="1.65" height="8.5" rx="0.825" fill="currentColor" />
      <rect x="7.175" y="1.75" width="1.65" height="12.5" rx="0.825" fill="currentColor" />
      <rect x="9.925" y="4.25" width="1.65" height="7.5" rx="0.825" fill="currentColor" />
      <rect x="12.675" y="5.75" width="1.65" height="4.5" rx="0.825" fill="currentColor" />
    </svg>
  );
}

export interface MatterGooeySendAction {
  readonly id: "dictate" | "voice-mode";
  readonly label: string;
  readonly shortcut?: string | null | undefined;
  readonly disabled?: boolean | undefined;
  readonly icon: ReactNode;
  readonly onSelect: () => void;
}

type GooeyPhase = "closed" | "opening" | "open" | "closing";

const GOOEY_STEP_PX = 38;
const GOOEY_STAGGER_MS = 40;
const GOOEY_OPEN_MS = 460;
const GOOEY_CLOSE_MS = 230;
const GOOEY_SVG_WIDTH = 88;
const GOOEY_SVG_HEIGHT = 168;
const GOOEY_ANCHOR_CX = 44;
const GOOEY_ANCHOR_CY = 130;
const GOOEY_CIRCLE_RADIUS = 14;
// Exact libraries.dev/gooey metaball alpha matrix (blur=6, contrast=18, intercept=0.5 - 18*5/12 = -7).
const GOOEY_COLOR_MATRIX = "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7";

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Right-click Send/Stop pop-out menu using the libraries.dev/gooey two-layer technique:
 * an SVG metaball silhouette layer behind crisp DOM buttons, mounted only while active
 * so the idle Send button carries zero SVG filter or GPU cost.
 */
export function MatterGooeySendAnchor({
  children,
  actions,
  anchorActive,
}: {
  readonly children: ReactNode;
  readonly actions: ReadonlyArray<MatterGooeySendAction>;
  readonly anchorActive: boolean;
}) {
  const gt = useGT();
  const [phase, setPhase] = useState<GooeyPhase>("closed");
  const [reducedMotion, setReducedMotion] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const rawFilterId = useId();
  const filterId = `matter-gooey-${rawFilterId.replace(/[^a-zA-Z0-9_-]/g, "")}`;

  if (actions.length === 0 && phase !== "closed") {
    setPhase("closed");
  }

  const closeMenu = () => {
    if (prefersReducedMotion()) {
      setReducedMotion(true);
      setPhase("closed");
      return;
    }
    setPhase((current) => (current === "closed" ? "closed" : "closing"));
  };

  const openMenu = () => {
    if (actions.length === 0) return;
    const reduce = prefersReducedMotion();
    setReducedMotion(reduce);
    setPhase(reduce ? "open" : "opening");
  };

  const dismissMenu = useEffectEvent(() => {
    closeMenu();
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- advances opening/closing animation phases and unmounts the SVG filter after closing
  useEffect(() => {
    if (phase === "opening") {
      const timeout = setTimeout(
        () => setPhase("open"),
        GOOEY_OPEN_MS + Math.max(0, actions.length - 1) * GOOEY_STAGGER_MS,
      );
      return () => clearTimeout(timeout);
    }
    if (phase === "closing") {
      const timeout = setTimeout(
        () => setPhase("closed"),
        GOOEY_CLOSE_MS + Math.max(0, actions.length - 1) * 25,
      );
      return () => clearTimeout(timeout);
    }
  }, [phase, actions.length]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds outside-click and Escape dismissal only while the pop-out is visible
  useEffect(() => {
    if (phase !== "opening" && phase !== "open") return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && anchorRef.current?.contains(target)) return;
      dismissMenu();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      dismissMenu();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [phase]);

  const handleContextMenu = (event: ReactMouseEvent<HTMLSpanElement>) => {
    if (actions.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    if (phase === "opening" || phase === "open") {
      closeMenu();
    } else {
      openMenu();
    }
  };

  const handlePrimaryClickCapture = () => {
    if (phase === "opening" || phase === "open") {
      closeMenu();
    }
  };

  const showOverlay = phase !== "closed" && actions.length > 0;
  const showGooeySvg = showOverlay && !reducedMotion;

  return (
    <span
      ref={anchorRef}
      data-matter-gooey-anchor=""
      data-matter-gooey-state={phase}
      onContextMenu={handleContextMenu}
    >
      {showOverlay ? (
        <span
          data-matter-gooey-stage=""
          data-state={phase}
          data-reduced-motion={reducedMotion ? "true" : undefined}
        >
          {showGooeySvg ? (
            <svg
              aria-hidden="true"
              focusable="false"
              data-matter-gooey-svg=""
              width={GOOEY_SVG_WIDTH}
              height={GOOEY_SVG_HEIGHT}
              viewBox={`0 0 ${GOOEY_SVG_WIDTH} ${GOOEY_SVG_HEIGHT}`}
            >
              <defs>
                <filter
                  id={filterId}
                  filterUnits="userSpaceOnUse"
                  x="0"
                  y="0"
                  width={GOOEY_SVG_WIDTH}
                  height={GOOEY_SVG_HEIGHT}
                  colorInterpolationFilters="sRGB"
                >
                  <feGaussianBlur in="SourceGraphic" stdDeviation="6" result="blur" />
                  <feColorMatrix in="blur" type="matrix" values={GOOEY_COLOR_MATRIX} result="goo" />
                  <feComposite in="SourceGraphic" in2="goo" operator="atop" />
                </filter>
              </defs>
              <g filter={`url(#${filterId})`}>
                <circle
                  cx={GOOEY_ANCHOR_CX}
                  cy={GOOEY_ANCHOR_CY}
                  r={GOOEY_CIRCLE_RADIUS}
                  data-matter-gooey-blob="anchor"
                  data-active={anchorActive ? "true" : "false"}
                />
                {actions.map((action, index) => {
                  const offsetY = -(index + 1) * GOOEY_STEP_PX;
                  const delayMs =
                    phase === "closing"
                      ? (actions.length - 1 - index) * 25
                      : index * GOOEY_STAGGER_MS;
                  const blobStyle = {
                    "--mc-gooey-y": `${offsetY}px`,
                    "--mc-gooey-delay": `${delayMs}ms`,
                  } as CSSProperties;
                  return (
                    <circle
                      key={action.id}
                      cx={GOOEY_ANCHOR_CX}
                      cy={GOOEY_ANCHOR_CY}
                      r={GOOEY_CIRCLE_RADIUS}
                      data-matter-gooey-blob="satellite"
                      style={blobStyle}
                    />
                  );
                })}
              </g>
            </svg>
          ) : null}

          <div role="group" aria-label={gt("Voice actions")} data-matter-gooey-actions="">
            {actions.map((action, index) => {
              const offsetY = -(index + 1) * GOOEY_STEP_PX;
              const delayMs =
                phase === "closing" ? (actions.length - 1 - index) * 25 : index * GOOEY_STAGGER_MS;
              const itemStyle = {
                "--mc-gooey-y": `${offsetY}px`,
                "--mc-gooey-delay": `${delayMs}ms`,
              } as CSSProperties;
              const fullLabel = action.shortcut
                ? `${action.label} (${action.shortcut})`
                : action.label;
              return (
                <button
                  key={action.id}
                  type="button"
                  className="rounded-full"
                  data-matter-gooey-action={action.id}
                  aria-label={action.label}
                  disabled={action.disabled || phase === "closing"}
                  tabIndex={phase === "closing" ? -1 : 0}
                  style={itemStyle}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={(event) => {
                    event.stopPropagation();
                    if (action.disabled || phase === "closing") return;
                    action.onSelect();
                    closeMenu();
                  }}
                >
                  {action.icon}
                  <span data-matter-gooey-label="" aria-hidden="true">
                    {fullLabel}
                  </span>
                </button>
              );
            })}
          </div>
        </span>
      ) : null}
      <span data-matter-gooey-primary="" onClickCapture={handlePrimaryClickCapture}>
        {children}
      </span>
    </span>
  );
}
