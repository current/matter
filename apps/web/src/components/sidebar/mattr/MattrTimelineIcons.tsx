import type { ReactNode, SVGProps } from "react";

/**
 * Timeline's 1.5px outline glyphs, hand-drawn on a 16px grid. They are plain SVG rather than
 * lucide imports, so the icon-pack plugin leaves them as outlines like the Doop frames.
 */
function Glyph({ children, ...props }: SVGProps<SVGSVGElement> & { children: ReactNode }) {
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

type IconProps = SVGProps<SVGSVGElement>;

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

/** A path forking off the main line: the thread works in its own worktree. */
export const WorktreeGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M2 8.5h3.5l6.5-5.25M9.25 3h2.75v2.75M5.5 8.5l2.25 1.85M10 12l2 1.5" />
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

export const GearGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <path d="M12.49 6.61 13.95 6.67 13.95 9.33 12.49 9.39 12.16 10.19 13.15 11.27 11.27 13.15 10.19 12.16 9.39 12.49 9.33 13.95 6.67 13.95 6.61 12.49 5.81 12.16 4.73 13.15 2.85 11.27 3.84 10.19 3.51 9.39 2.05 9.33 2.05 6.67 3.51 6.61 3.84 5.81 2.85 4.73 4.73 2.85 5.81 3.84 6.61 3.51 6.67 2.05 9.33 2.05 9.39 3.51 10.19 3.84 11.27 2.85 13.15 4.73 12.16 5.81Z" />
    <circle cx="8" cy="8" r="1.9" />
  </Glyph>
);

export const HelpGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="8" cy="8" r="6" />
    <path d="M6.3 6.3a1.8 1.8 0 0 1 3.5.55c0 1.2-1.8 1.45-1.8 2.65M8 11.3v.05" />
  </Glyph>
);

/** A track ring and a quarter arc; the arc turns only while the row is running. */
export const SpinnerGlyph = (props: IconProps) => (
  <Glyph {...props}>
    <circle cx="8" cy="8" r="5.5" opacity="0.28" />
    <path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" />
  </Glyph>
);
