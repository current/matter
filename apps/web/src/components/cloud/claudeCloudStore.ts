import { shouldWatchMatterCloudRuns } from "@t3tools/client-runtime/matter/cloud-runs";
import type {
  ClaudeCloudAccountProblemNote,
  ClaudeCloudPendingRequest,
  ClaudeCloudRemoteSession,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useSyncExternalStore } from "react";

import {
  fetchClaudeCloudRemoteSessions,
  fetchClaudeCloudTranscript,
} from "../../addons/claudeCloudApi";
import { MatterApiError, type MatterApiConfig } from "../../addons/matterApi";
import {
  cloudTranscriptPollDelay,
  isCloudSessionActive,
  mergeCloudTranscriptRows,
  type CloudTranscriptRow,
} from "./claudeCloudTranscript.logic";

/**
 * Claude Cloud's client state: the account's session list and one transcript per open session.
 * Both poll only while something holds them and the page is visible.
 */

const isMatterApiError = Schema.is(MatterApiError);

export function cloudErrorText(cause: unknown): string {
  if (isMatterApiError(cause)) return cause.detail ?? cause.code;
  return cause instanceof Error ? cause.message : String(cause);
}

const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

let visibilityListening = false;
function ensureVisibilityListener() {
  if (visibilityListening || typeof document === "undefined") return;
  visibilityListening = true;
  document.addEventListener("visibilitychange", () => {
    if (pageHidden()) {
      stopListTimer();
      for (const entry of transcripts.values()) clearTimer(entry);
      return;
    }
    if (listRefs > 0 || (watchRefs > 0 && shouldWatchMatterCloudRuns(list.sessions))) {
      void loadList();
    }
    for (const entry of transcripts.values()) {
      if (entry.refs > 0) void pollTranscript(entry);
    }
  });
}

// ── Session list ───────────────────────────────────────────────────────────────────────────

export interface ClaudeCloudSessionsState {
  /** Null until the first read. */
  readonly sessions: ReadonlyArray<ClaudeCloudRemoteSession> | null;
  readonly problems: ReadonlyArray<ClaudeCloudAccountProblemNote>;
  readonly error: string | null;
}

const LIST_ACTIVE_POLL_MS = 15_000;
const LIST_IDLE_POLL_MS = 60_000;

let list: ClaudeCloudSessionsState = { sessions: null, problems: [], error: null };
let listRefs = 0;
/** Holders that only follow chats' cloud runs (the pill, the sidebars), not the whole list. */
let watchRefs = 0;
let listConfig: MatterApiConfig | null = null;
let listTimer: ReturnType<typeof setTimeout> | null = null;
let listController: AbortController | null = null;

function stopListTimer() {
  if (listTimer !== null) clearTimeout(listTimer);
  listTimer = null;
}

function scheduleList() {
  stopListTimer();
  if (pageHidden()) return;
  if (listRefs > 0) {
    const active = list.sessions?.some((session) => isCloudSessionActive(session.state));
    listTimer = setTimeout(() => void loadList(), active ? LIST_ACTIVE_POLL_MS : LIST_IDLE_POLL_MS);
  } else if (watchRefs > 0 && shouldWatchMatterCloudRuns(list.sessions)) {
    listTimer = setTimeout(() => void loadList(), LIST_ACTIVE_POLL_MS);
  }
}

function releaseList() {
  if (listRefs > 0 || watchRefs > 0) {
    scheduleList();
    return;
  }
  stopListTimer();
  listController?.abort();
  listController = null;
}

async function loadList() {
  const config = listConfig;
  if (config === null) return;
  listController?.abort();
  const controller = new AbortController();
  listController = controller;
  stopListTimer();
  try {
    const response = await fetchClaudeCloudRemoteSessions(config, { signal: controller.signal });
    if (controller.signal.aborted) return;
    list = { sessions: response.sessions, problems: response.problems, error: null };
    emit();
  } catch (cause) {
    if (controller.signal.aborted) return;
    list = { ...list, error: cloudErrorText(cause) };
    emit();
  }
  if (listController === controller) listController = null;
  scheduleList();
}

/** Keeps the session list fresh while held; returns the release. */
export function retainClaudeCloudSessions(config: MatterApiConfig): () => void {
  ensureVisibilityListener();
  listRefs += 1;
  const changed = listConfig !== config;
  listConfig = config;
  if (changed || (list.sessions === null && listController === null)) void loadList();
  else if (listTimer === null && listController === null) scheduleList();
  return () => {
    listRefs -= 1;
    releaseList();
  };
}

/**
 * Follows the cloud runs chats started: one read when first held, then reads only while one of
 * them was last seen running or waiting on input, and on `nudgeClaudeCloudRuns`.
 */
export function retainClaudeCloudRunWatch(config: MatterApiConfig): () => void {
  ensureVisibilityListener();
  watchRefs += 1;
  const changed = listConfig !== config;
  listConfig = config;
  if (changed || (list.sessions === null && listController === null)) void loadList();
  else if (listTimer === null && listController === null) scheduleList();
  return () => {
    watchRefs -= 1;
    releaseList();
  };
}

export function refreshClaudeCloudSessions(): void {
  if (listRefs > 0 || watchRefs > 0) void loadList();
}

const nudgeKeys = new Map<string, string>();

/**
 * A chat's run started or ended, so it may have launched a cloud run: read once now. The first
 * key seen for a chat only records it, so opening a chat doesn't read.
 */
export function nudgeClaudeCloudRuns(threadKey: string, runKey: string): void {
  const previous = nudgeKeys.get(threadKey);
  nudgeKeys.set(threadKey, runKey);
  if (previous === undefined || previous === runKey) return;
  if (watchRefs > 0 && listController === null && !pageHidden()) void loadList();
}

const getList = () => list;

export function useClaudeCloudSessionsState(): ClaudeCloudSessionsState {
  return useSyncExternalStore(subscribe, getList, getList);
}

/** A session the transcript just reported, so the sidebar's dot follows the open view. */
function patchListedSession(session: ClaudeCloudRemoteSession) {
  if (list.sessions === null) return;
  const index = list.sessions.findIndex((entry) => entry.id === session.id);
  if (index === -1) {
    list = { ...list, sessions: [session, ...list.sessions] };
  } else {
    const current = list.sessions[index];
    if (
      current?.state === session.state &&
      current.title === session.title &&
      current.unread === session.unread &&
      current.needsAction === session.needsAction
    ) {
      return;
    }
    list = { ...list, sessions: list.sessions.with(index, session) };
  }
  emit();
}

// ── Transcripts ────────────────────────────────────────────────────────────────────────────

export interface ClaudeCloudTranscriptState {
  readonly loaded: boolean;
  readonly session: ClaudeCloudRemoteSession | null;
  readonly rev: number | null;
  readonly rows: ReadonlyArray<CloudTranscriptRow>;
  readonly pendingRequest: ClaudeCloudPendingRequest | null;
  readonly canInterrupt: boolean;
  readonly error: string | null;
  /** The server answered 404: the session is gone or this account can't read it. */
  readonly missing: boolean;
}

const EMPTY_CLOUD_TRANSCRIPT: ClaudeCloudTranscriptState = {
  loaded: false,
  session: null,
  rev: null,
  rows: [],
  pendingRequest: null,
  canInterrupt: false,
  error: null,
  missing: false,
};

const BOOST_MS = 30_000;

interface TranscriptEntry {
  readonly sessionId: string;
  state: ClaudeCloudTranscriptState;
  refs: number;
  config: MatterApiConfig | null;
  instanceId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  controller: AbortController | null;
  boostUntil: number;
}

const transcripts = new Map<string, TranscriptEntry>();

function entryFor(sessionId: string): TranscriptEntry {
  let entry = transcripts.get(sessionId);
  if (!entry) {
    entry = {
      sessionId,
      state: EMPTY_CLOUD_TRANSCRIPT,
      refs: 0,
      config: null,
      instanceId: null,
      timer: null,
      controller: null,
      boostUntil: 0,
    };
    transcripts.set(sessionId, entry);
  }
  return entry;
}

function clearTimer(entry: TranscriptEntry) {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
}

function scheduleTranscript(entry: TranscriptEntry) {
  clearTimer(entry);
  if (entry.refs === 0 || pageHidden() || entry.state.missing) return;
  const delay = cloudTranscriptPollDelay(entry.state.session, Date.now() < entry.boostUntil);
  entry.timer = setTimeout(() => void pollTranscript(entry), delay);
}

function setTranscript(entry: TranscriptEntry, state: ClaudeCloudTranscriptState) {
  entry.state = state;
  emit();
}

async function pollTranscript(entry: TranscriptEntry) {
  const config = entry.config;
  if (config === null || entry.controller !== null) return;
  clearTimer(entry);
  const controller = new AbortController();
  entry.controller = controller;
  const current = entry.state;
  try {
    const response = await fetchClaudeCloudTranscript(config, entry.sessionId, {
      sinceRev: current.rev,
      instanceId: entry.instanceId,
      signal: controller.signal,
    });
    if (controller.signal.aborted) return;
    const latest = entry.state;
    setTranscript(entry, {
      loaded: true,
      session: response.session,
      rev: response.rev,
      rows: mergeCloudTranscriptRows(latest.rev === null ? null : latest.rows, response),
      pendingRequest: response.pendingRequest,
      canInterrupt: response.canInterrupt,
      error: null,
      missing: false,
    });
    patchListedSession(response.session);
  } catch (cause) {
    if (controller.signal.aborted) return;
    const missing = isMatterApiError(cause) && cause.status === 404;
    setTranscript(entry, {
      ...entry.state,
      loaded: true,
      error: cloudErrorText(cause),
      missing,
    });
  } finally {
    if (entry.controller === controller) entry.controller = null;
  }
  scheduleTranscript(entry);
}

/** Follows one session's transcript while held; returns the release. */
export function retainClaudeCloudTranscript(
  config: MatterApiConfig,
  sessionId: string,
  instanceId: string | null,
): () => void {
  ensureVisibilityListener();
  const entry = entryFor(sessionId);
  entry.refs += 1;
  const changed = entry.config !== config || entry.instanceId !== instanceId;
  entry.config = config;
  entry.instanceId = instanceId;
  if (changed || entry.timer === null) void pollTranscript(entry);
  return () => {
    entry.refs -= 1;
    if (entry.refs > 0) return;
    clearTimer(entry);
    entry.controller?.abort();
    entry.controller = null;
  };
}

/** Reads now and keeps reading fast for a while, as after a send or a stop. */
export function pollClaudeCloudTranscriptSoon(sessionId: string): void {
  const entry = transcripts.get(sessionId);
  if (!entry) return;
  entry.boostUntil = Date.now() + BOOST_MS;
  if (entry.refs > 0 && entry.controller === null) void pollTranscript(entry);
}

/** The item as last read, for expanded rows: cloud items arrive whole, with their output. */
export function getClaudeCloudTranscriptItem(sessionId: string, itemId: string) {
  return transcripts.get(sessionId)?.state.rows.find((row) => row.item.id === itemId)?.item ?? null;
}

export function useClaudeCloudTranscript(sessionId: string): ClaudeCloudTranscriptState {
  const get = () => transcripts.get(sessionId)?.state ?? EMPTY_CLOUD_TRANSCRIPT;
  return useSyncExternalStore(subscribe, get, get);
}

/** Tests only: forgets every session and transcript. */
export function resetClaudeCloudStoreForTests(): void {
  for (const entry of transcripts.values()) {
    clearTimer(entry);
    entry.controller?.abort();
  }
  transcripts.clear();
  stopListTimer();
  listController?.abort();
  listController = null;
  list = { sessions: null, problems: [], error: null };
  listRefs = 0;
  watchRefs = 0;
  nudgeKeys.clear();
  listConfig = null;
  emit();
}
