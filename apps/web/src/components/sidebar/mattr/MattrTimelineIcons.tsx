import type { ComponentProps, ReactNode } from "react";

import { observeVisibleAnimation } from "../../../lib/visibleAnimation";

/**
 * Timeline's 1.5px outline glyphs, hand-drawn on a 16px grid. They are plain SVG rather than
 * lucide imports, so the icon-pack plugin leaves them as outlines like the Doop frames.
 */
function Glyph({ children, ...props }: ComponentProps<"svg"> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={props["aria-label"] === undefined ? true : undefined}
      {...props}
    >
      {children}
    </svg>
  );
}

type IconProps = ComponentProps<"svg">;

export const ComposeGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M13.5 8.75V12a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12V4A1.5 1.5 0 0 1 4 2.5h3.25" />
    <path d="M11.55 2.45a1.42 1.42 0 0 1 2 2L8.3 9.7l-2.55.55.55-2.55z" />
  </Glyph>
);

export const BoardGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <rect x="2.25" y="3" width="11.5" height="10" rx="1.75" />
    <path d="M6.1 3v10M9.9 3v10" />
  </Glyph>
);

export const PullRequestOpenGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="4.5" cy="3.75" r="1.6" />
    <circle cx="4.5" cy="12.25" r="1.6" />
    <circle cx="11.5" cy="12.25" r="1.6" />
    <path d="M4.5 5.35v5.3M11.5 10.65V6.5a2 2 0 0 0-2-2H7.75M9.25 3 7.75 4.5 9.25 6" />
  </Glyph>
);

/** Two branch paths merging into one lower node so merged PRs differ by shape, not color alone. */
export const PullRequestMergedGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="4.5" cy="3.75" r="1.6" />
    <circle cx="11.5" cy="3.75" r="1.6" />
    <circle cx="4.5" cy="12.25" r="1.6" />
    <path d="M4.5 5.35v5.3M11.5 5.35v.9a3.5 3.5 0 0 1-3.5 3.5H4.5" />
  </Glyph>
);

export const PullRequestClosedGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="4.5" cy="3.75" r="1.6" />
    <circle cx="4.5" cy="12.25" r="1.6" />
    <circle cx="11.5" cy="12.25" r="1.6" />
    <path d="M4.5 5.35v5.3M10 3.25l3 3M13 3.25l-3 3" />
  </Glyph>
);

export const ClockGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M8 4.9v3.35l2.1 1.3" />
  </Glyph>
);

export const SearchGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="7.1" cy="7.1" r="4.35" />
    <path d="m10.4 10.4 3.1 3.1" />
  </Glyph>
);

export const InboxGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M2.5 9h2.9l.9 1.6h3.4l.9-1.6h2.9" />
  </Glyph>
);

export const SortGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M5 13V3M2.75 5.25 5 3l2.25 2.25M11 3v10M8.75 10.75 11 13l2.25-2.25" />
  </Glyph>
);

export const ChevronGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="m6.5 4.75 3.25 3.25-3.25 3.25" />
  </Glyph>
);

export const ChevronDownGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="m4.75 6.5 3.25 3.25 3.25-3.25" />
  </Glyph>
);

/** Continuous fork optically aligned to FolderGlyph's x=2.5 left origin. */
export const WorktreeGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M2.5 8h4.25l5.5-4.5M9.75 3.5h2.5V6M6.75 8l5.5 4.5" />
  </Glyph>
);

export const FolderGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M2.5 4.75a1.5 1.5 0 0 1 1.5-1.5h2.35l1.4 1.5H12a1.5 1.5 0 0 1 1.5 1.5v5.5a1.5 1.5 0 0 1-1.5 1.5H4a1.5 1.5 0 0 1-1.5-1.5z" />
    <path d="M2.5 6.5h11" />
  </Glyph>
);

export const BranchGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="4.75" cy="3.75" r="1.5" />
    <circle cx="4.75" cy="12.25" r="1.5" />
    <circle cx="11.25" cy="4.5" r="1.5" />
    <path d="M4.75 5.25v5.5M11.25 6v.25a3 3 0 0 1-3 3h-.5a3 3 0 0 0-3 1.5" />
  </Glyph>
);

export const PinGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M9.6 2.75 13.25 6.4l-1.45 1.45-2.6-.55-2.1 2.1.55 2.05-1.15 1.15-2.1-2.1-1.9 1.9M6.55 9.45 4.4 7.3l1.15-1.15 2.05.55 2.1-2.1-.55-2.6" />
  </Glyph>
);

export const CloseGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="m4.5 4.5 7 7M11.5 4.5l-7 7" />
  </Glyph>
);

export const MoreGlyph = (props: IconProps) => (
  <Glyph {...props} fill="currentColor" stroke="none">
    <circle cx="3.75" cy="8" r="1.1" />
    <circle cx="8" cy="8" r="1.1" />
    <circle cx="12.25" cy="8" r="1.1" />
  </Glyph>
);

export const GearGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M6.8 2.35h2.4l.45 1.55c.44.13.85.32 1.22.56l1.48-.62 1.2 2.08-1.08 1.2c.06.28.1.58.1.88s-.04.6-.1.88l1.08 1.2-1.2 2.08-1.48-.62c-.37.24-.78.43-1.22.56l-.45 1.55H6.8l-.45-1.55a4.6 4.6 0 0 1-1.22-.56l-1.48.62-1.2-2.08 1.08-1.2A4.5 4.5 0 0 1 3.43 8c0-.3.04-.6.1-.88l-1.08-1.2 1.2-2.08 1.48.62c.37-.24.78-.43 1.22-.56z" />
    <circle cx="8" cy="8" r="2.05" />
  </Glyph>
);

export const HelpGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="8" cy="8" r="5.75" />
    <path d="M6.35 6.35a1.75 1.75 0 0 1 3.4.55c0 1.15-1.75 1.4-1.75 2.55M8 11.2v.05" />
  </Glyph>
);

/** A track ring and a quarter arc; pauses via IntersectionObserver when offscreen or collapsed. */
export const SpinnerGlyph = (props: IconProps) => (
  <Glyph ref={observeVisibleAnimation} {...props}>
    <circle cx="8" cy="8" r="5.5" opacity="0.2" />
    <path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" strokeWidth={1.65} />
  </Glyph>
);
