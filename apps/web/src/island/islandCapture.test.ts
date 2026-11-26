import { describe, expect, it } from "vite-plus/test";

import { captureTaskTitle, composeCaptureText } from "./islandCapture";

const file = { name: "shot.png", path: "/Users/me/Desktop/shot.png" };

describe("island capture", () => {
  it("sends the note with each dropped file path and link on its own line", () => {
    expect(composeCaptureText("  look at this ", [file], ["https://x.dev/a"])).toBe(
      "look at this\n\n/Users/me/Desktop/shot.png\nhttps://x.dev/a",
    );
    expect(composeCaptureText("", [file], [])).toBe("/Users/me/Desktop/shot.png");
    expect(composeCaptureText("just text", [], [])).toBe("just text");
  });

  it("titles a task from the note's first line, else the drop", () => {
    expect(captureTaskTitle("Fix login\nmore detail", [], [])).toBe("Fix login");
    expect(captureTaskTitle("", [file], [])).toBe("shot.png");
    expect(captureTaskTitle("", [], ["https://x.dev/a"])).toBe("https://x.dev/a");
    expect(captureTaskTitle("x".repeat(200), [], [])).toHaveLength(120);
  });
});
