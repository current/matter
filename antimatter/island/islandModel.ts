import type {
  IslandCaptureTarget,
  IslandDisplayMetrics,
  IslandPendingApproval,
  IslandPendingPlan,
  IslandPendingUserInput,
  IslandSnapshot,
  IslandThreadSummary,
} from "./types.ts";

export type IslandWingKind =
  | "idle"
  | "listening"
  | "needs-you"
  | "failed"
  | "running"
  | "running-many"
  | "done";

export interface IslandWing {
  readonly kind: IslandWingKind;
  /** Driver kind behind the left glyph; null draws the neutral mark. */
  readonly providerKind: string | null;
  readonly count: number;
  readonly progress: { readonly completed: number; readonly total: number } | null;
  /** Event-driven dot step (tool calls so far), drawn as one of three lit dots. */
  readonly step: number;
  readonly wingWidth: number;
  /** When this wing stops being true without a new snapshot (just-finished ✓); null if never. */
  readonly expiresAt: number | null;
}

export type IslandNeedsYouItem =
  | {
      readonly kind: "approval";
      readonly id: string;
      readonly threadKey: string;
      readonly providerKind: string | null;
      readonly item: IslandPendingApproval;
    }
  | {
      readonly kind: "question";
      readonly id: string;
      readonly threadKey: string;
      readonly providerKind: string | null;
      readonly item: IslandPendingUserInput;
    }
  | {
      readonly kind: "plan";
      readonly id: string;
      readonly threadKey: string;
      readonly providerKind: string | null;
      readonly item: IslandPendingPlan;
    };

export type IslandMode = "hidden" | "collapsed" | "peek" | "open";
export type IslandOpenCard = "drop" | "needs-you" | "prompt" | "glance";

export interface IslandPeekRow {
  readonly kind: "needs-you" | "running" | "done" | "failed";
  readonly threadKey: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly detail: string;
  readonly providerKind: string | null;
  readonly needsYou: IslandNeedsYouItem | null;
}

export interface IslandAutoPeekState {
  readonly seen: ReadonlyArray<string>;
  readonly until: number;
}

export interface IslandModifierGestureState {
  readonly lastTapAt: number | null;
}

/** When the actionable item on screen last changed, so a stale press can't answer the next one. */
export interface IslandInputGuardState {
  readonly key: string;
  readonly since: number;
}

/** Request ids answered from the island; anything with `has` (a Set or an id → time Map). */
export interface IslandAnsweredIds {
  readonly has: (id: string) => boolean;
}

export interface IslandShellGeometry {
  readonly width: number;
  readonly height: number;
  readonly ear: number;
  readonly bottomRadius: number;
  readonly pill: boolean;
}

/**
 * The island's pure logic. Everything lives inside this one function so the notch renderer can
 * embed `islandModelRuntime.toString()` in its data: URL document; keep it free of imports and
 * module-level references.
 */
export function islandModelRuntime() {
  const JUST_FINISHED_MS = 4000;
  const AUTO_PEEK_MS = 3000;
  const HOVER_DWELL_MS = 150;
  const DOUBLE_TAP_MS = 400;
  const WING = 36;
  const WING_ALERT = 44;
  const WING_VOICE = 64;
  const PEEK_WIDTH = 360;
  const OPEN_WIDTH = 420;
  const MAX_ROWS = 4;
  const PILL_TOP = 6;
  const INPUT_GUARD_MS = 300;
  // A response that hasn't cleared the request by then probably failed: show it again.
  const ANSWER_TIMEOUT_MS = 8000;

  function keyOf(environmentId: string, threadId: string): string {
    return environmentId + ":" + threadId;
  }

  function threadByKey(snapshot: IslandSnapshot): Map<string, IslandThreadSummary> {
    const map = new Map<string, IslandThreadSummary>();
    for (const thread of snapshot.recentThreads) map.set(thread.key, thread);
    return map;
  }

  function isListening(snapshot: IslandSnapshot): boolean {
    const phase = snapshot.voice ? snapshot.voice.phase : "idle";
    if (phase === "preparing" || phase === "recording" || phase === "transcribing") return true;
    const assistant = snapshot.assistant;
    if (!assistant) return false;
    return (
      assistant.handsFreeActive ||
      assistant.phase === "listening" ||
      assistant.phase === "speaking" ||
      assistant.phase === "thinking" ||
      assistant.phase === "acting" ||
      assistant.phase === "transcribing"
    );
  }

  /** Approvals, then questions, then plans: the order the Open card pages through. */
  function needsYouItems(
    snapshot: IslandSnapshot,
    answered?: IslandAnsweredIds,
  ): IslandNeedsYouItem[] {
    const threads = threadByKey(snapshot);
    const provider = (key: string) => {
      const thread = threads.get(key);
      return thread ? thread.providerKind : null;
    };
    const items: IslandNeedsYouItem[] = [];
    for (const item of snapshot.pendingApprovals) {
      if (answered && answered.has(item.requestId)) continue;
      const threadKey = keyOf(item.environmentId, item.threadId);
      items.push({
        kind: "approval",
        id: item.requestId,
        threadKey,
        providerKind: provider(threadKey),
        item,
      });
    }
    for (const item of snapshot.pendingUserInputs) {
      if (answered && answered.has(item.requestId)) continue;
      const threadKey = keyOf(item.environmentId, item.threadId);
      items.push({
        kind: "question",
        id: item.requestId,
        threadKey,
        providerKind: provider(threadKey),
        item,
      });
    }
    for (const item of snapshot.pendingPlans || []) {
      if (answered && answered.has(item.planId)) continue;
      const threadKey = keyOf(item.environmentId, item.threadId);
      items.push({
        kind: "plan",
        id: item.planId,
        threadKey,
        providerKind: provider(threadKey),
        item,
      });
    }
    return items;
  }

  function runningThreads(snapshot: IslandSnapshot): IslandThreadSummary[] {
    return snapshot.recentThreads
      .filter((thread) => thread.status === "running")
      .toSorted(
        (a, b) =>
          Date.parse(b.runStartedAt || b.updatedAt) - Date.parse(a.runStartedAt || a.updatedAt),
      );
  }

  function wing(
    kind: IslandWingKind,
    providerKind: string | null,
    extra?: Partial<IslandWing>,
  ): IslandWing {
    return {
      kind,
      providerKind,
      count: 0,
      progress: null,
      step: 0,
      wingWidth: kind === "needs-you" ? WING_ALERT : kind === "listening" ? WING_VOICE : WING,
      expiresAt: null,
      ...extra,
    };
  }

  /**
   * One glyph per wing: who on the left, state on the right. Listening beats everything (the
   * user is talking), then whatever needs the user, then failures, then running work, then the
   * 4 s ✓ for a run that just finished.
   */
  function deriveWing(
    snapshot: IslandSnapshot | null,
    nowMs: number,
    answered?: IslandAnsweredIds,
  ): IslandWing {
    if (!snapshot || !snapshot.settings.enabled) return wing("idle", null);
    if (isListening(snapshot)) return wing("listening", null);
    if (!snapshot.settings.showNotifications) return wing("idle", null);
    const threads = threadByKey(snapshot);
    const needs = needsYouItems(snapshot, answered);
    if (needs.length > 0) {
      return wing("needs-you", needs[0]!.providerKind, { count: needs.length });
    }
    const failed = snapshot.doneNotifications.find(
      (entry) => entry.outcome === "failed" || entry.outcome === "limited",
    );
    if (failed) {
      const thread = threads.get(failed.key);
      return wing("failed", thread ? thread.providerKind : null, { count: 1 });
    }
    const running = runningThreads(snapshot);
    if (running.length > 1) {
      return wing("running-many", running[0]!.providerKind, { count: running.length });
    }
    if (running.length === 1) {
      const thread = running[0]!;
      const plan = thread.plan && thread.plan.total > 0 ? thread.plan : null;
      return wing("running", thread.providerKind, {
        count: 1,
        progress: plan ? { completed: plan.completed, total: plan.total } : null,
        step: thread.toolCallCount,
      });
    }
    const latest = snapshot.doneNotifications[0];
    if (latest && latest.outcome !== "failed" && latest.outcome !== "limited") {
      const expiresAt = latest.completedAt + JUST_FINISHED_MS;
      if (nowMs < expiresAt) {
        const thread = threads.get(latest.key);
        return wing("done", thread ? thread.providerKind : null, { count: 1, expiresAt });
      }
    }
    return wing("idle", null);
  }

  function resolveMode(input: {
    readonly open: boolean;
    readonly dropActive: boolean;
    readonly hoverPeek: boolean;
    readonly autoPeeking: boolean;
    readonly wingKind: IslandWingKind;
  }): IslandMode {
    if (input.open || input.dropActive) return "open";
    if (input.hoverPeek || input.autoPeeking) return "peek";
    return input.wingKind === "idle" ? "hidden" : "collapsed";
  }

  /**
   * Drop > Needs you > Prompt > Glance. A draft the user is writing pins Prompt so an incoming
   * request never swaps the card under their typing; the request waits behind the amber wing.
   */
  function chooseOpenCard(input: {
    readonly dropActive: boolean;
    readonly needsYouCount: number;
    readonly hasDraft: boolean;
    readonly wantsPrompt: boolean;
    readonly glanceCount: number;
  }): IslandOpenCard {
    if (input.dropActive) return "drop";
    if (input.hasDraft) return "prompt";
    if (input.needsYouCount > 0) return "needs-you";
    if (input.wantsPrompt || input.glanceCount === 0) return "prompt";
    return "glance";
  }

  function activityText(thread: IslandThreadSummary): string {
    if (thread.currentActivity) return thread.currentActivity.label;
    if (thread.plan && thread.plan.currentStep) return thread.plan.currentStep;
    return "Working";
  }

  function needsYouText(item: IslandNeedsYouItem): string {
    if (item.kind === "approval")
      return item.item.title + (item.item.detail ? " · " + item.item.detail : "");
    if (item.kind === "question") {
      const first = item.item.questions[0];
      return first ? first.question : "Has a question";
    }
    return "Plan ready" + (item.item.stepCount > 0 ? " · " + item.item.stepCount + " to-dos" : "");
  }

  /** Read-only Peek: needs-you rows (approvals answer inline), then running, then finished. */
  function peekRows(snapshot: IslandSnapshot, answered?: IslandAnsweredIds): IslandPeekRow[] {
    const threads = threadByKey(snapshot);
    const rows: IslandPeekRow[] = [];
    const seenThreads = new Set<string>();
    for (const item of needsYouItems(snapshot, answered)) {
      if (rows.length >= MAX_ROWS) return rows;
      const thread = threads.get(item.threadKey);
      seenThreads.add(item.threadKey);
      rows.push({
        kind: "needs-you",
        threadKey: item.threadKey,
        environmentId: item.item.environmentId,
        threadId: item.item.threadId,
        title: item.item.threadTitle,
        detail: needsYouText(item),
        providerKind: thread ? thread.providerKind : item.providerKind,
        needsYou: item,
      });
    }
    for (const thread of runningThreads(snapshot)) {
      if (rows.length >= MAX_ROWS) return rows;
      if (seenThreads.has(thread.key)) continue;
      seenThreads.add(thread.key);
      rows.push({
        kind: "running",
        threadKey: thread.key,
        environmentId: thread.environmentId,
        threadId: thread.threadId,
        title: thread.title,
        detail: activityText(thread),
        providerKind: thread.providerKind,
        needsYou: null,
      });
    }
    for (const entry of snapshot.doneNotifications) {
      if (rows.length >= MAX_ROWS) return rows;
      if (seenThreads.has(entry.key)) continue;
      seenThreads.add(entry.key);
      const thread = threads.get(entry.key);
      const failed = entry.outcome === "failed" || entry.outcome === "limited";
      rows.push({
        kind: failed ? "failed" : "done",
        threadKey: entry.key,
        environmentId: entry.environmentId,
        threadId: entry.threadId,
        title: entry.threadTitle,
        detail: entry.outcome === "limited" ? "Usage limit" : failed ? "Failed" : "Done",
        providerKind: thread ? thread.providerKind : null,
        needsYou: null,
      });
    }
    return rows;
  }

  /** Glance: active threads first, then the most recently updated. */
  function glanceThreads(snapshot: IslandSnapshot): IslandThreadSummary[] {
    const active = (thread: IslandThreadSummary) =>
      thread.status === "running" || thread.status === "approval" || thread.status === "input"
        ? 1
        : 0;
    return snapshot.recentThreads
      .toSorted(
        (a, b) => active(b) - active(a) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
      )
      .slice(0, MAX_ROWS);
  }

  function captureTargets(snapshot: IslandSnapshot): IslandCaptureTarget[] {
    const targets: IslandCaptureTarget[] = [];
    const threads = threadByKey(snapshot);
    const selected =
      (snapshot.selectedThreadKey ? threads.get(snapshot.selectedThreadKey) : undefined) ||
      snapshot.recentThreads[0];
    if (selected) {
      targets.push({
        kind: "thread",
        environmentId: selected.environmentId,
        threadId: selected.threadId,
      });
    }
    if (snapshot.canStartThread) targets.push({ kind: "new-thread" });
    if (snapshot.canCreateTask) targets.push({ kind: "task" });
    return targets;
  }

  function sameTarget(a: IslandCaptureTarget | null, b: IslandCaptureTarget | null): boolean {
    if (!a || !b || a.kind !== b.kind) return false;
    if (a.kind === "thread" && b.kind === "thread") {
      return a.environmentId === b.environmentId && a.threadId === b.threadId;
    }
    return true;
  }

  /** A thread's title from the recent list, else from a request it is waiting on. */
  function threadTitle(snapshot: IslandSnapshot, key: string): string | null {
    const recent = snapshot.recentThreads.find((thread) => thread.key === key);
    if (recent) return recent.title;
    const waiting = [
      ...snapshot.pendingApprovals,
      ...snapshot.pendingUserInputs,
      ...(snapshot.pendingPlans || []),
    ].find((item) => keyOf(item.environmentId, item.threadId) === key);
    return waiting ? waiting.threadTitle : null;
  }

  /**
   * The composer's target stays put once chosen (on open, by a drop, Tab or Revise…): a thread
   * target holds until that thread is gone, New thread / Task until they become unavailable.
   */
  function reconcileTarget(
    snapshot: IslandSnapshot,
    current: IslandCaptureTarget | null,
  ): IslandCaptureTarget | null {
    const targets = captureTargets(snapshot);
    if (current && current.kind === "thread") {
      if (threadTitle(snapshot, keyOf(current.environmentId, current.threadId)) !== null) {
        return current;
      }
    } else if (current && targets.some((candidate) => sameTarget(candidate, current))) {
      return current;
    }
    return targets[0] || null;
  }

  /** Local absolute paths only go to threads on this Mac; a task just keeps them as a note. */
  function capturePathsAllowed(
    snapshot: IslandSnapshot,
    target: IslandCaptureTarget | null,
  ): boolean {
    if (!target) return false;
    if (target.kind === "task") return true;
    const local = snapshot.localEnvironmentId;
    if (!local) return false;
    if (target.kind === "thread") return target.environmentId === local;
    const reference = captureTargets(snapshot).find((candidate) => candidate.kind === "thread");
    return Boolean(reference && reference.kind === "thread" && reference.environmentId === local);
  }

  function stripControlCharacters(text: string): string {
    let out = "";
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (code >= 0x20 && (code < 0x7f || code > 0x9f)) out += char;
    }
    return out;
  }

  function hasControlCharacters(text: string): boolean {
    return stripControlCharacters(text) !== text;
  }

  /** `text/uri-list` links worth keeping: http(s) and file only, comments dropped. */
  function acceptedDropLinks(uriList: string): string[] {
    return uriList
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && /^(https?|file):/i.test(line))
      .filter((line) => !hasControlCharacters(line));
  }

  /** Inline Approve / Deny only when the request really offers a plain accept and decline. */
  function inlineApprovalChoices(approval: IslandPendingApproval): {
    readonly accept: IslandPendingApproval["options"][number];
    readonly decline: IslandPendingApproval["options"][number];
  } | null {
    const accept = approval.options.find((option) => option.decision === "accept");
    const decline = approval.options.find((option) => option.decision === "decline");
    return accept && decline ? { accept, decline } : null;
  }

  function stepInputGuard(
    state: IslandInputGuardState,
    key: string,
    nowMs: number,
  ): IslandInputGuardState {
    return key === state.key ? state : { key, since: nowMs };
  }

  /** Blocks presses for a moment after the item under them changed (double clicks, key repeat). */
  function isInputGuarded(state: IslandInputGuardState, nowMs: number): boolean {
    return state.key !== "" && nowMs - state.since < INPUT_GUARD_MS;
  }

  /** Forgets answers whose request cleared, and ones still live after the timeout. */
  function pruneAnswered(
    answered: ReadonlyMap<string, number>,
    liveIds: ReadonlySet<string>,
    nowMs: number,
  ): Map<string, number> {
    const kept = new Map<string, number>();
    for (const [id, at] of answered) {
      if (liveIds.has(id) && nowMs - at < ANSWER_TIMEOUT_MS) kept.set(id, at);
    }
    return kept;
  }

  /** Tab order: → thread, New thread, Task, back to the thread. */
  function nextTarget(
    targets: ReadonlyArray<IslandCaptureTarget>,
    current: IslandCaptureTarget | null,
  ): IslandCaptureTarget | null {
    if (targets.length === 0) return null;
    const index = targets.findIndex((target) => sameTarget(target, current));
    return targets[(index + 1) % targets.length] || null;
  }

  /** `/plan …` and `/goal …` pick the turn's interaction mode; the prefix is not sent. */
  function parseCapturePrefix(text: string): {
    readonly interactionMode: "default" | "plan" | "goal";
    readonly text: string;
  } {
    const match = /^\s*\/(plan|goal)(?:\s+|$)/i.exec(text);
    if (!match) return { interactionMode: "default", text: text.trim() };
    return {
      interactionMode: match[1]!.toLowerCase() === "plan" ? "plan" : "goal",
      text: text.slice(match[0].length).trim(),
    };
  }

  /**
   * Each request id peeks once, for 3 s, the first time it shows up while the island is not
   * open. Hover or click take over from there; the amber wing stays until then.
   */
  function stepAutoPeek(
    state: IslandAutoPeekState,
    ids: ReadonlyArray<string>,
    nowMs: number,
    canPeek: boolean,
  ): IslandAutoPeekState {
    const seen = new Set(state.seen);
    let fresh = false;
    for (const id of ids) {
      if (!seen.has(id)) {
        seen.add(id);
        fresh = true;
      }
    }
    const live = new Set(ids);
    const kept = [...seen].filter((id) => live.has(id));
    return { seen: kept, until: fresh && canPeek ? nowMs + AUTO_PEEK_MS : state.until };
  }

  function isAutoPeeking(state: IslandAutoPeekState, nowMs: number): boolean {
    return nowMs < state.until;
  }

  /**
   * Modifier taps: a second clean tap within 400 ms opens or closes the island; a lone tap does
   * nothing, so tapping ⌃ for other apps stays harmless.
   */
  function stepModifierGesture(
    state: IslandModifierGestureState,
    event: "tap" | "hold-start" | "hold-end" | "hold-cancel",
    nowMs: number,
  ): { readonly state: IslandModifierGestureState; readonly toggle: boolean } {
    if (event !== "tap") {
      return { state: event === "hold-end" ? { lastTapAt: null } : state, toggle: false };
    }
    if (state.lastTapAt !== null && nowMs - state.lastTapAt <= DOUBLE_TAP_MS) {
      return { state: { lastTapAt: null }, toggle: true };
    }
    return { state: { lastTapAt: nowMs }, toggle: false };
  }

  /** Shell size per mode. Hidden is exactly the camera housing (0 px beyond it). */
  function shellGeometry(
    mode: IslandMode,
    current: IslandWing,
    metrics: IslandDisplayMetrics,
    contentHeight: number,
  ): IslandShellGeometry {
    const notchW = metrics.notchWidth;
    const notchH = metrics.notchHeight;
    const pill = !metrics.hasNotch;
    if (mode === "hidden") {
      return { width: notchW, height: notchH, ear: 0, bottomRadius: pill ? notchH / 2 : 10, pill };
    }
    if (mode === "collapsed") {
      return {
        width: Math.round(notchW + current.wingWidth * 2),
        height: notchH,
        ear: pill ? 0 : 8,
        bottomRadius: pill ? notchH / 2 : 10,
        pill,
      };
    }
    const width = mode === "peek" ? PEEK_WIDTH : OPEN_WIDTH;
    return {
      // Whole points, so the shoulder arcs meet the body edge without a half-pixel kink.
      width: Math.round(Math.max(width, notchW + current.wingWidth * 2)),
      height: notchH + Math.max(0, contentHeight),
      ear: pill ? 0 : 18,
      bottomRadius: 24,
      pill,
    };
  }

  return {
    JUST_FINISHED_MS,
    AUTO_PEEK_MS,
    HOVER_DWELL_MS,
    DOUBLE_TAP_MS,
    PILL_TOP,
    INPUT_GUARD_MS,
    ANSWER_TIMEOUT_MS,
    keyOf,
    isListening,
    needsYouItems,
    deriveWing,
    resolveMode,
    chooseOpenCard,
    peekRows,
    glanceThreads,
    captureTargets,
    sameTarget,
    threadTitle,
    reconcileTarget,
    capturePathsAllowed,
    stripControlCharacters,
    hasControlCharacters,
    acceptedDropLinks,
    inlineApprovalChoices,
    stepInputGuard,
    isInputGuarded,
    pruneAnswered,
    nextTarget,
    parseCapturePrefix,
    stepAutoPeek,
    isAutoPeeking,
    stepModifierGesture,
    shellGeometry,
  };
}

export const islandModel = islandModelRuntime();
