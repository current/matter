import type { IslandDroppedFile } from "../../../../antimatter/island/types";

const TASK_TITLE_MAX = 120;

/** The note, then each dropped file's absolute path and each link, one per line. */
export function composeCaptureText(
  text: string,
  files: ReadonlyArray<IslandDroppedFile>,
  urls: ReadonlyArray<string>,
): string {
  const lines = [...files.map((file) => file.path), ...urls];
  const note = text.trim();
  if (lines.length === 0) return note;
  return note ? `${note}\n\n${lines.join("\n")}` : lines.join("\n");
}

/** A task's title: the note's first line, else the first dropped file or link. */
export function captureTaskTitle(
  text: string,
  files: ReadonlyArray<IslandDroppedFile>,
  urls: ReadonlyArray<string>,
): string {
  const firstLine = text.trim().split("\n")[0]?.trim() ?? "";
  const title = firstLine || files[0]?.name || urls[0] || "";
  return title.length > TASK_TITLE_MAX ? `${title.slice(0, TASK_TITLE_MAX - 1).trimEnd()}…` : title;
}
