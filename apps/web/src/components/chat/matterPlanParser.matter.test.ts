import { describe, expect, it } from "vite-plus/test";

import { parseMatterPlanOverview, stripInlineMarkdown } from "./matterPlanParser.matter";

describe("parseMatterPlanOverview", () => {
  it("reads the title, first prose paragraph and checklist items", () => {
    const overview = parseMatterPlanOverview(
      [
        "# Session auth migration",
        "",
        "Ship cookie-based sessions with middleware and tests.",
        "Includes a safe rollout path for production.",
        "",
        "## To-dos",
        "- [ ] Add migration for sessions table",
        "- [x] Wire auth middleware",
        "- [ ] Update login flow + tests",
      ].join("\n"),
    );
    expect(overview).toEqual({
      title: "Session auth migration",
      summary:
        "Ship cookie-based sessions with middleware and tests. Includes a safe rollout path for production.",
      steps: [
        { text: "Add migration for sessions table", done: false },
        { text: "Wire auth middleware", done: true },
        { text: "Update login flow + tests", done: false },
      ],
    });
  });

  it("prefers the steps section over other bullets and skips test plans", () => {
    const overview = parseMatterPlanOverview(
      [
        "# Plan",
        "## Summary",
        "Move **sessions** to [cookies](https://example.com).",
        "## Key Changes",
        "- Add `sessions` table",
        "  - nested detail",
        "- Wire middleware",
        "## Test Plan",
        "- Run the suite",
      ].join("\n"),
    );
    expect(overview.summary).toBe("Move sessions to cookies.");
    expect(overview.steps.map((entry) => entry.text)).toEqual([
      "Add sessions table",
      "Wire middleware",
    ]);
  });

  it("falls back to numbered items anywhere, then top-level bullets", () => {
    expect(
      parseMatterPlanOverview("# T\n\nIntro.\n\n1. First\n2) Second\n   - detail").steps,
    ).toEqual([
      { text: "First", done: false },
      { text: "Second", done: false },
    ]);
    expect(parseMatterPlanOverview("- one\n  - two\n- three").steps.map((s) => s.text)).toEqual([
      "one",
      "three",
    ]);
  });

  it("skips a step-named title heading and empty step sections without falling into Test Plan", () => {
    const overview = parseMatterPlanOverview(
      [
        "# Implementation plan",
        "",
        "Migrate background jobs to a single queue.",
        "",
        "## Implementation",
        "High-level notes before the concrete task list.",
        "",
        "## Steps",
        "- Create the job queue table",
        "- Migrate workers to pull from the queue",
        "",
        "## Test Plan",
        "1. Run integration tests",
        "2. Verify retry backoff",
      ].join("\n"),
    );
    expect(overview.title).toBe("Implementation plan");
    expect(overview.summary).toBe("Migrate background jobs to a single queue.");
    expect(overview.steps.map((entry) => entry.text)).toEqual([
      "Create the job queue table",
      "Migrate workers to pull from the queue",
    ]);
  });

  it("does not pull late Rollback or Risks prose up as the summary when there is no intro", () => {
    const withStepsHeading = parseMatterPlanOverview(
      [
        "# Auth migration",
        "",
        "## Steps",
        "1. Add sessions table",
        "2. Wire middleware",
        "",
        "## Rollback",
        "Drop the sessions table and revert middleware.",
      ].join("\n"),
    );
    expect(withStepsHeading.summary).toBeNull();
    expect(withStepsHeading.steps.map((entry) => entry.text)).toEqual([
      "Add sessions table",
      "Wire middleware",
    ]);

    const withLeadingList = parseMatterPlanOverview(
      [
        "# Auth migration",
        "",
        "- Add sessions table",
        "- Wire middleware",
        "",
        "## Risks",
        "Existing cookies could expire early.",
      ].join("\n"),
    );
    expect(withLeadingList.summary).toBeNull();

    const withOverview = parseMatterPlanOverview(
      [
        "# Auth migration",
        "",
        "## Overview",
        "Switch sessions to HTTP-only cookies.",
        "",
        "## Steps",
        "1. Add sessions table",
      ].join("\n"),
    );
    expect(withOverview.summary).toBe("Switch sessions to HTTP-only cookies.");
  });

  it("ignores fenced code and returns empty parts for prose-free plans", () => {
    const overview = parseMatterPlanOverview("```\n# not a title\n- [ ] not a step\n```");
    expect(overview).toEqual({ title: null, summary: null, steps: [] });
  });

  it("does not take quotes or tables as the summary", () => {
    expect(parseMatterPlanOverview("# T\n> quote\n| a |\n\nReal summary").summary).toBe(
      "Real summary",
    );
  });
});

describe("stripInlineMarkdown", () => {
  it("keeps identifiers with underscores intact", () => {
    expect(stripInlineMarkdown("Rename snake_case_name and *emphasis*")).toBe(
      "Rename snake_case_name and emphasis",
    );
  });
});
