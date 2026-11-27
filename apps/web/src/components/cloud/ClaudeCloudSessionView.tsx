import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  claudeCloudSessionUrl,
  type ClaudeCloudPendingRequest,
  type ClaudeCloudRemoteSession,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { T, useGT, useMessages } from "gt-react";
import {
  CircleAlertIcon,
  CloudDownloadIcon,
  CloudIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FolderIcon,
  GitBranchIcon,
  LinkIcon,
  MessageCircleQuestionIcon,
} from "lucide-react";
import {
  type Dispatch,
  type FormEvent,
  type KeyboardEvent,
  type SetStateAction,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  interruptClaudeCloudSession,
  openClaudeCloudDialog,
  sendClaudeCloudFollowUp,
  teleportClaudeCloudSession,
} from "../../addons/claudeCloudApi";
import { type MatterApiConfig, useMatterApiConfig } from "../../addons/matterApi";
import { isElectron } from "../../env";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { randomUUID } from "../../lib/utils";
import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { buildThreadRouteParams } from "../../threadRoutes";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { ComposerSurface } from "../chat/ComposerSurface";
import { ClaudeAI } from "../Icons";
import { MatterProviderMark } from "../sidebar/matter/MatterDefaultSidebarParts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { CLAUDE_CLOUD_STATE_BADGE, CLAUDE_CLOUD_STATE_LABELS } from "./claudeCloudCopy";
import {
  cloudErrorText,
  pollClaudeCloudTranscriptSoon,
  retainClaudeCloudSessions,
  retainClaudeCloudTranscript,
  useClaudeCloudSessionsState,
  useClaudeCloudTranscript,
} from "./claudeCloudStore";
import { ClaudeCloudTimeline } from "./ClaudeCloudTimeline";
import {
  cloudEchoMessage,
  cloudSessionSource,
  pendingCloudEchoes,
  userItemIds,
  type CloudEcho,
} from "./claudeCloudTranscript.logic";

const decodeInstanceId = Schema.decodeUnknownOption(ProviderInstanceId);

/** A request's value or its error's detail, so components need no try/finally (React Compiler). */
async function settle<A>(
  request: Promise<A>,
): Promise<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: string }
> {
  try {
    return { ok: true, value: await request };
  } catch (cause) {
    return { ok: false, error: cloudErrorText(cause) };
  }
}
const NO_MESSAGES: ReadonlyArray<never> = [];
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/** A Claude Cloud session in Matter's page card: its transcript, live, and a composer to reply. */
export function ClaudeCloudSessionView({
  sessionId,
  instanceId: instanceIdParam,
}: {
  sessionId: string;
  instanceId: string | null;
}) {
  const gt = useGT();
  const config = useMatterApiConfig();
  const listed = useClaudeCloudSessionsState().sessions?.find((entry) => entry.id === sessionId);
  const transcript = useClaudeCloudTranscript(sessionId);
  const session = transcript.session ?? listed ?? null;
  const instanceId = session?.instanceId ?? instanceIdParam;
  const [echoes, setEchoes] = useState<ReadonlyArray<CloudEcho>>([]);
  // A sent message the transcript hasn't shown yet is about to start a turn.
  const sending = pendingCloudEchoes(echoes, transcript.rows).length > 0;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the session's transcript and the account's session list on the server while the page is open
  useEffect(() => {
    if (config === null) return;
    const releaseTranscript = retainClaudeCloudTranscript(config, sessionId, instanceId);
    const releaseList = retainClaudeCloudSessions(config);
    return () => {
      releaseTranscript();
      releaseList();
    };
  }, [config, sessionId, instanceId]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel={gt("Claude Cloud breadcrumb")} className="flex-1">
          <WorkspaceBreadcrumbItem className="shrink-0 gap-1.5">
            <MatterProviderMark driver={CLAUDE_DRIVER} />
            <WorkspaceBreadcrumbText>{gt("Claude Cloud")}</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator>
            <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbSeparator>
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1 gap-2">
            <h1 className="min-w-0">
              <WorkspaceBreadcrumbText>{session?.title || sessionId}</WorkspaceBreadcrumbText>
            </h1>
            {session ? <CloudSessionMeta session={session} sending={sending} /> : null}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {config !== null ? (
          <CloudSessionActions config={config} sessionId={sessionId} session={session} />
        ) : null}
      </WorkspacePageHeader>

      {/* Single child under WorkspacePageHeader so Matter's shell.css wraps the body in its card. */}
      <div className="relative flex min-h-0 flex-1 flex-col bg-background">
        {config === null || (!transcript.loaded && session === null) ? (
          <CloudLoading />
        ) : transcript.missing ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>{gt("This cloud session isn't available")}</EmptyTitle>
              <EmptyDescription>
                {transcript.error ??
                  gt("It may have been deleted, or none of your Claude accounts can read it.")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <CloudSessionBody
            key={sessionId}
            config={config}
            sessionId={sessionId}
            session={session}
            instanceId={instanceId}
            echoes={echoes}
            setEchoes={setEchoes}
          />
        )}
      </div>
    </SidebarInset>
  );
}

function CloudLoading() {
  return (
    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Spinner size="sm" aria-hidden="true" />
      <span role="status">
        <T>Loading session…</T>
      </span>
    </div>
  );
}

/** The account's display name and the model's catalog name, falling back to the raw ids. */
function useCloudSessionLabels(session: ClaudeCloudRemoteSession | null) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const providers = useEnvironmentProviders();
  const provider = (
    primaryEnvironmentId === null ? undefined : providers.get(primaryEnvironmentId)
  )?.find((candidate) => candidate.instanceId === session?.instanceId);
  const slug = session?.model ?? null;
  const known = provider?.models.find(
    (candidate) => candidate.slug === slug || (slug !== null && candidate.aliases?.includes(slug)),
  );
  const model = slug === null ? null : (known?.name ?? slug);
  // The composer shows the model beside Claude's mark, as the native picker does ("Opus 5.5").
  const shortModel =
    slug === null ? null : (known?.shortName ?? model?.replace(/^Claude\s+/i, "") ?? slug);
  return { account: provider?.displayName ?? session?.instanceId ?? null, model, shortModel };
}

function CloudSessionMeta({
  session,
  sending,
}: {
  session: ClaudeCloudRemoteSession;
  sending: boolean;
}) {
  const m = useMessages();
  const { account, model } = useCloudSessionLabels(session);
  const state = sending && session.state === "idle" ? "running" : session.state;
  // Repository, branch and model already sit in the composer, so the header keeps only the state.
  const details = [cloudSessionSource(session), session.branch, model, account].filter(
    (part): part is string => Boolean(part),
  );
  const badge = (
    <Badge variant={CLAUDE_CLOUD_STATE_BADGE[state]} data-claude-cloud-header-state={state}>
      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
      {m(CLAUDE_CLOUD_STATE_LABELS[state])}
    </Badge>
  );
  if (details.length === 0) return badge;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>{badge}</TooltipTrigger>
      <TooltipPopup>{details.join(" · ")}</TooltipPopup>
    </Tooltip>
  );
}

function CloudSessionActions({
  config,
  sessionId,
  session,
}: {
  config: MatterApiConfig;
  sessionId: string;
  session: ClaudeCloudRemoteSession | null;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const [teleporting, setTeleporting] = useState(false);
  const url = session?.url ?? claudeCloudSessionUrl(sessionId);
  const tracked = session?.tracked ?? null;
  const { copyToClipboard } = useCopyToClipboard({
    onCopy: () => toastManager.add({ type: "success", title: gt("Link copied") }),
  });

  const pullToWorktree = async () => {
    const projectId = tracked?.projectId ?? null;
    if (projectId === null) {
      openClaudeCloudDialog({ mode: "teleport", sessionId });
      return;
    }
    setTeleporting(true);
    const result = await settle(
      teleportClaudeCloudSession(config, {
        sessionId,
        projectId,
        ...(session ? { instanceId: session.instanceId } : {}),
      }),
    );
    setTeleporting(false);
    if (!result.ok) {
      toastManager.add({
        type: "error",
        title: gt("Couldn't pull the session"),
        description: result.error,
      });
      return;
    }
    if (result.value.threadId !== null && primaryEnvironmentId !== null) {
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(primaryEnvironmentId, result.value.threadId)),
      });
      return;
    }
    toastManager.add({
      type: "success",
      title: gt("Pulled into a local worktree"),
      description: gt("Teleported into {path}. Its thread will appear once the session imports.", {
        path: result.value.worktreePath,
      }),
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <Button
        size="xs"
        variant="outline"
        disabled={teleporting}
        data-claude-cloud-teleport=""
        onClick={() => void pullToWorktree()}
      >
        {teleporting ? (
          <Spinner size="xs" aria-hidden="true" />
        ) : (
          <CloudDownloadIcon aria-hidden="true" />
        )}
        <span className="hidden md:inline">{gt("Pull to local worktree")}</span>
      </Button>
      <Button
        size="xs"
        variant="outline"
        render={<a href={url} target="_blank" rel="noreferrer noopener" />}
      >
        <ExternalLinkIcon aria-hidden="true" />
        <span className="hidden md:inline">{gt("Open in claude.ai")}</span>
      </Button>
      <Menu>
        <MenuTrigger
          render={<Button size="icon-xs" variant="outline" aria-label={gt("More actions")} />}
        >
          <EllipsisIcon aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => copyToClipboard(url, undefined)}>
            <LinkIcon aria-hidden="true" />
            {gt("Copy link")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

function CloudSessionBody({
  config,
  sessionId,
  session,
  instanceId,
  echoes,
  setEchoes,
}: {
  config: MatterApiConfig;
  sessionId: string;
  session: ClaudeCloudRemoteSession | null;
  instanceId: string | null;
  echoes: ReadonlyArray<CloudEcho>;
  setEchoes: Dispatch<SetStateAction<ReadonlyArray<CloudEcho>>>;
}) {
  const gt = useGT();
  const transcript = useClaudeCloudTranscript(sessionId);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const state = session?.state ?? null;
  const archived = state === "archived";
  const waiting = pendingCloudEchoes(echoes, transcript.rows);
  // A sent message the transcript hasn't shown yet is about to start a turn.
  const isWorking = state === "running" || waiting.length > 0;
  const optimisticMessages = waiting.length === 0 ? NO_MESSAGES : waiting.map(cloudEchoMessage);
  const lastUserAt = transcript.rows.findLast((row) => row.item.type === "user_message")?.item
    .startedAt;
  const workStartedAt = isWorking
    ? (waiting.at(-1)?.createdAt ??
      (lastUserAt ? DateTime.formatIso(lastUserAt) : session?.updatedAt) ??
      null)
    : null;
  const resolvedInstanceId = Option.getOrUndefined(decodeInstanceId(instanceId));

  const send = async (text: string) => {
    const echo: CloudEcho = {
      id: randomUUID(),
      text,
      createdAt: new Date().toISOString(),
      knownUserItemIds: userItemIds(transcript.rows),
    };
    setEchoes((current) => [...current, echo]);
    setSendError(null);
    const result = await settle(
      sendClaudeCloudFollowUp(config, {
        sessionId,
        prompt: text,
        ...(resolvedInstanceId ? { instanceId: resolvedInstanceId } : {}),
      }),
    );
    if (!result.ok) {
      setEchoes((current) => current.filter((entry) => entry.id !== echo.id));
      setSendError(result.error);
      setDraft((current) => (current.trim() === "" ? text : current));
      return;
    }
    pollClaudeCloudTranscriptSoon(sessionId);
  };

  const stop = async () => {
    setStopping(true);
    setStopError(null);
    const result = await settle(
      interruptClaudeCloudSession(config, {
        sessionId,
        ...(resolvedInstanceId ? { instanceId: resolvedInstanceId } : {}),
      }),
    );
    setStopping(false);
    if (!result.ok) setStopError(result.error);
    pollClaudeCloudTranscriptSoon(sessionId);
  };

  const notices: Array<ComposerBannerStackItem> = [];
  const request = transcript.pendingRequest;
  // A turn that ended on a question needs only a reply; only open prompts block the session.
  if (request !== null) {
    notices.push(
      pendingNotice({
        request,
        needsAction: session?.needsAction ?? null,
        url: session?.url ?? claudeCloudSessionUrl(sessionId),
        gt,
      }),
    );
  }
  if (state === "failed") {
    notices.push({
      id: "failed",
      variant: "error",
      icon: <CircleAlertIcon />,
      title: gt("This cloud session failed"),
      description: session?.summary ?? undefined,
    });
  }
  if (transcript.error !== null && !transcript.missing) {
    notices.push({
      id: "read-error",
      variant: "warning",
      icon: <CircleAlertIcon />,
      title: gt("Couldn't read the latest messages"),
      description: transcript.error,
    });
  }
  const actionError = sendError ?? stopError;
  if (actionError !== null) {
    notices.push({
      id: "send-error",
      variant: "error",
      icon: <CircleAlertIcon />,
      title:
        sendError !== null ? gt("Couldn't send your message") : gt("Couldn't stop the session"),
      description: actionError,
      dismissLabel: gt("Dismiss error"),
      onDismiss: () => {
        setSendError(null);
        setStopError(null);
      },
    });
  }

  return (
    <div
      data-chat-canvas
      className="flex h-full min-h-0 flex-col [--chat-lane-inset-end:0px] [--chat-lane-inset-start:0px] [--chat-timeline-gutter:0px]"
    >
      {transcript.loaded ? (
        <ClaudeCloudTimeline
          sessionId={sessionId}
          rows={transcript.rows}
          optimisticMessages={optimisticMessages}
          isWorking={isWorking}
          workStartedAt={workStartedAt}
          awaitingUser={state === "needs_input"}
        >
          {({ scrollToEnd }) => (
            <CloudComposer
              session={session}
              notices={notices}
              draft={draft}
              onDraftChange={setDraft}
              textareaRef={textareaRef}
              disabledReason={
                archived
                  ? gt("This session is archived. Open it on claude.ai to restore it.")
                  : null
              }
              showStop={isWorking}
              stopOpensClaude={!transcript.canInterrupt}
              stopping={stopping}
              onSend={(text) => {
                scrollToEnd();
                void send(text);
              }}
              onStop={() => {
                if (transcript.canInterrupt) {
                  void stop();
                  return;
                }
                window.open(
                  session?.url ?? claudeCloudSessionUrl(sessionId),
                  "_blank",
                  "noopener,noreferrer",
                );
              }}
            />
          )}
        </ClaudeCloudTimeline>
      ) : (
        <CloudLoading />
      )}
    </div>
  );
}

function pendingNotice({
  request,
  needsAction,
  url,
  gt,
}: {
  request: ClaudeCloudPendingRequest;
  needsAction: string | null;
  url: string;
  gt: ReturnType<typeof useGT>;
}): ComposerBannerStackItem {
  const title =
    request.title ||
    (request.kind === "permission"
      ? gt("Claude is waiting for your permission")
      : request.kind === "plan"
        ? gt("Claude is waiting for you to review its plan")
        : gt("Claude is waiting for your answer"));
  const detail = [request.detail, needsAction].filter(
    (part, index, parts): part is string =>
      typeof part === "string" && part.trim() !== "" && parts.indexOf(part) === index,
  );
  return {
    id: "pending-request",
    variant: "warning",
    icon: <MessageCircleQuestionIcon />,
    title,
    description: request.title ? gt("Claude is waiting for you") : undefined,
    children: (
      <ComposerBanner.Body
        className="flex flex-col gap-1 pt-0.5 pb-1.5 pe-2 text-xs whitespace-pre-wrap text-muted-foreground"
        data-claude-cloud-pending=""
      >
        {detail.map((part) => (
          <span key={part} className="text-foreground/80">
            {part}
          </span>
        ))}
        <span>{gt("Answering from Matter isn't supported yet.")}</span>
      </ComposerBanner.Body>
    ),
    actions: (
      <Button
        size="xs"
        variant="ghost"
        render={<a href={url} target="_blank" rel="noreferrer noopener" />}
      >
        <ExternalLinkIcon aria-hidden="true" />
        {gt("Answer on claude.ai")}
      </Button>
    ),
  };
}

function CloudComposer({
  session,
  notices,
  draft,
  onDraftChange,
  textareaRef,
  disabledReason,
  showStop,
  stopOpensClaude,
  stopping,
  onSend,
  onStop,
}: {
  session: ClaudeCloudRemoteSession | null;
  notices: ReadonlyArray<ComposerBannerStackItem>;
  draft: string;
  onDraftChange: (draft: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  disabledReason: string | null;
  showStop: boolean;
  /** Claude's CLI can't interrupt cloud sessions, so Stop hands off to claude.ai. */
  stopOpensClaude: boolean;
  stopping: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const gt = useGT();
  const hasContent = draft.trim().length > 0;
  const disabled = disabledReason !== null;
  const replaceSendWithStop = showStop && !hasContent;
  const source = session ? cloudSessionSource(session) : null;
  const modelLabel = useCloudSessionLabels(session).shortModel;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || disabled) return;
    onDraftChange("");
    onSend(text);
    textareaRef.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    submit();
  };

  return (
    <div className="chat-composer-lane flex shrink-0 flex-col pt-1.5 pb-4 sm:pt-2 sm:pb-5">
      <div className="mx-auto w-full max-w-(--chat-content-max-width)">
        <ComposerSurface.Shell data-matter-composer="" contextRow={source !== null}>
          <ComposerSurface.Host>
            <form
              onSubmit={submit}
              data-claude-cloud-composer=""
              className="relative z-10 w-full min-w-0"
            >
              <ComposerBanner.Dock>
                <ComposerBanner.Column>
                  <ComposerBannerStack items={notices} />
                </ComposerBanner.Column>
              </ComposerBanner.Dock>
              <ComposerSurface.Main>
                <div data-chat-composer-surface="true" className="rounded-2xl">
                  <div data-chat-composer-body="true" className="relative px-4 pt-3.5 pb-2 sm:pt-4">
                    <textarea
                      ref={textareaRef}
                      value={draft}
                      onChange={(event) => onDraftChange(event.target.value)}
                      onKeyDown={onKeyDown}
                      rows={1}
                      disabled={disabled}
                      placeholder={disabledReason ?? gt("Reply to Claude Cloud")}
                      aria-label={gt("Reply to Claude Cloud")}
                      className="field-sizing-content block max-h-52 min-h-[2lh] w-full resize-none bg-transparent text-base leading-relaxed text-foreground placeholder:text-muted-foreground/65 focus:outline-none disabled:cursor-not-allowed sm:text-sm"
                    />
                  </div>
                  <div
                    data-chat-composer-footer="true"
                    className="flex min-w-0 flex-nowrap items-center justify-end gap-2 px-2 pb-2"
                  >
                    <div className="flex min-w-0 items-center gap-1.5">
                      {modelLabel ? (
                        <span
                          className="flex min-w-0 items-center gap-1.5 px-1.5 text-sm text-foreground/90"
                          data-claude-cloud-model=""
                        >
                          <ClaudeAI aria-hidden className="size-3.5 shrink-0" />
                          <span className="truncate">{modelLabel}</span>
                        </span>
                      ) : null}
                      {showStop ? (
                        <CloudStopButton
                          stopping={stopping}
                          opensClaude={stopOpensClaude}
                          onStop={onStop}
                        />
                      ) : null}
                      {replaceSendWithStop ? null : (
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="submit"
                                data-claude-cloud-send=""
                                disabled={disabled || !hasContent}
                                aria-label={gt("Send")}
                                className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer hover:bg-message-action-hover disabled:pointer-events-none disabled:opacity-64 sm:h-8 sm:w-8 [&_svg]:pointer-events-none"
                              />
                            }
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          </TooltipTrigger>
                          <TooltipPopup>{gt("Submit message")}</TooltipPopup>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                </div>
              </ComposerSurface.Main>
            </form>
          </ComposerSurface.Host>
          {source !== null ? (
            <ComposerSurface.ContextStrip>
              <span className="flex min-w-0 items-center gap-3 ps-1.5">
                <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground/80">
                  <FolderIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{session?.repository ?? source}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-info-foreground">
                  <CloudIcon aria-hidden="true" className="size-3.5" />
                  {gt("Cloud")}
                </span>
              </span>
              {session?.branch ? (
                <span
                  className="ms-auto flex min-w-0 items-center gap-1.5 pe-1.5"
                  data-claude-cloud-branch=""
                >
                  <GitBranchIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-70" />
                  <span className="truncate">{session.branch}</span>
                </span>
              ) : null}
            </ComposerSurface.ContextStrip>
          ) : null}
        </ComposerSurface.Shell>
      </div>
    </div>
  );
}

function CloudStopButton({
  stopping,
  opensClaude,
  onStop,
}: {
  stopping: boolean;
  opensClaude: boolean;
  onStop: () => void;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-claude-cloud-stop=""
            disabled={stopping}
            onClick={onStop}
            aria-label={stopping ? gt("Stopping") : gt("Stop generation")}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs transition-colors duration-150 hover:bg-destructive disabled:cursor-default disabled:opacity-64 [&_svg]:pointer-events-none"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>
        {stopping
          ? gt("Stopping…")
          : opensClaude
            ? gt("Stop on claude.ai")
            : gt("Interrupt", { $context: "verb, stops the running agent" })}
      </TooltipPopup>
    </Tooltip>
  );
}
