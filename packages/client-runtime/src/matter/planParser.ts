/** Matter: what the Plan Overview card shows of a proposed plan's markdown. */

export interface MatterPlanStep {
  readonly text: string;
  readonly done: boolean;
}

export interface MatterPlanOverview {
  readonly title: string | null;
  readonly summary: string | null;
  readonly steps: ReadonlyArray<MatterPlanStep>;
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const CHECKLIST_ITEM = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.+)$/;
const NUMBERED_ITEM = /^(\s*)\d{1,3}[.)]\s+(.+)$/;
const BULLET_ITEM = /^(\s*)[-*+]\s+(.+)$/;
const NON_PROSE = /^\s*(?:[-*+]\s|\d{1,3}[.)]\s|>|\||<|!\[|---|\*\*\*|___)/;
const LIST_ITEM = /^\s*(?:[-*+]\s|\d{1,3}[.)]\s)/;
const SUMMARY_HEADING = /\b(?:summary|overview)\b/i;
const STEP_HEADING = /\b(?:steps?|tasks?|to-?dos?|changes|implementation|milestones?|phases?)\b/i;
const TEST_HEADING = /\btest/i;

/** Plain text for one line of inline markdown: links keep their label, markers drop. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, "$1$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

interface Line {
  readonly text: string;
  readonly isHeading: boolean;
  /** The nearest heading above, or null before the first one. */
  readonly section: string | null;
}

function contentLines(markdown: string): Line[] {
  const lines: Line[] = [];
  let section: string | null = null;
  let inFence = false;
  for (const text of markdown.split(/\r?\n/)) {
    if (FENCE.test(text)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const headingMatch = text.match(HEADING);
    if (headingMatch) {
      section = stripInlineMarkdown(headingMatch[2] ?? "");
      lines.push({ text, isHeading: true, section });
      continue;
    }
    lines.push({ text, isHeading: false, section });
  }
  return lines;
}

function firstSummary(lines: ReadonlyArray<Line>, titleHeadingIndex: number): string | null {
  const paragraph: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.isHeading) {
      if (paragraph.length > 0) break;
      if (i === titleHeadingIndex) continue;
      if (line.section !== null && SUMMARY_HEADING.test(line.section)) continue;
      break;
    }
    if (LIST_ITEM.test(line.text)) break;
    const blank = line.text.trim().length === 0;
    if (blank || NON_PROSE.test(line.text)) {
      if (paragraph.length > 0) break;
      continue;
    }
    paragraph.push(line.text.trim());
  }
  const summary = stripInlineMarkdown(paragraph.join(" "));
  return summary.length > 0 ? summary : null;
}

function step(text: string, done = false): MatterPlanStep | null {
  const clean = stripInlineMarkdown(text);
  return clean.length > 0 ? { text: clean, done } : null;
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

function topLevelIndent(lines: ReadonlyArray<Line>, pattern: RegExp): number {
  let indent = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    const match = line.text.match(pattern);
    if (match) indent = Math.min(indent, match[1]?.length ?? 0);
  }
  return indent;
}

function collect(lines: ReadonlyArray<Line>, pattern: RegExp, textGroup: number) {
  const indent = topLevelIndent(lines, pattern);
  return lines
    .map((line) => {
      const match = line.text.match(pattern);
      if (!match || (match[1]?.length ?? 0) !== indent) return null;
      return step(match[textGroup] ?? "");
    })
    .filter(present);
}

function planSteps(lines: ReadonlyArray<Line>, titleHeadingIndex: number): MatterPlanStep[] {
  const checklist = lines
    .map((line) => {
      const match = line.text.match(CHECKLIST_ITEM);
      return match ? step(match[3] ?? "", match[2] !== " ") : null;
    })
    .filter(present);
  if (checklist.length > 0) return checklist;

  for (let i = 0; i < lines.length; i += 1) {
    if (i === titleHeadingIndex) continue;
    const line = lines[i]!;
    if (!line.isHeading || line.section === null) continue;
    if (!STEP_HEADING.test(line.section) || TEST_HEADING.test(line.section)) continue;
    const section: Line[] = [];
    for (let j = i + 1; j < lines.length && !lines[j]!.isHeading; j += 1) {
      section.push(lines[j]!);
    }
    const numbered = collect(section, NUMBERED_ITEM, 2);
    if (numbered.length > 0) return numbered;
    const bullets = collect(section, BULLET_ITEM, 2);
    if (bullets.length > 0) return bullets;
  }

  const nonTestLines = lines.filter(
    (line) => line.section === null || !TEST_HEADING.test(line.section),
  );
  const numbered = collect(nonTestLines, NUMBERED_ITEM, 2);
  if (numbered.length > 0) return numbered;
  return collect(nonTestLines, BULLET_ITEM, 2);
}

export function parseMatterPlanOverview(markdown: string): MatterPlanOverview {
  const lines = contentLines(markdown);
  const titleHeadingIndex = lines.findIndex((line) => line.isHeading);
  const title = titleHeadingIndex >= 0 ? (lines[titleHeadingIndex]?.section ?? "") : "";
  return {
    title: title.length > 0 ? title : null,
    summary: firstSummary(lines, titleHeadingIndex),
    steps: planSteps(lines, titleHeadingIndex),
  };
}
