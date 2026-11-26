/**
 * Rebrands server-emitted timeline copy (notifications, system notices, errors) at display time so
 * both newly emitted and persisted SQLite history rows show "Matter" without breaking server tests.
 */
export function rebrandTimelineServerText(text: string): string {
  if (!text.includes("T3")) return text;
  return text
    .replace(/\bT3(\s+)Connect\b/g, "Matter$1Connect")
    .replace(/\bT3\s+Code(?! for GitHub)/g, "Matter")
    .replace(/\bT3(\s+)(threads?|[Ss]erver|home|process)\b/g, "Matter$1$2");
}
