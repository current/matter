import type {
  BotActivityState,
  BotConversation,
  BotConversationListResponse,
  BotIdentity,
  BotMessage,
  BotMessagesPage,
  BotPendingRequest,
  BotProviderDescriptor,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import { T, useGT, useMessages } from "gt-react";
import { ChevronRightIcon, ClockIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  MattrApiError,
  mattrApiRequest,
  useMattrApiConfig,
  type MattrApiConfig,
} from "../../addons/mattrApi";
import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerSurface } from "../chat/ComposerSurface";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./BotAvatarRenderer";
import { BOT_ACTIVITY_DOT, BOT_ACTIVITY_LABELS } from "./botActivity";
import {
  applyBotConversationEvent,
  prependBotMessages,
  scheduledTriggerDetail,
  upsertBotMessage,
} from "./botConversationModel";
import { findBot, retainBotsSync, subscribeBotEvents, useBotsState } from "./botsStore";

const PAGE_SIZE = 50;

const isMattrApiError = Schema.is(MattrApiError);

const messagesQuery = (providerId: string, conversationId: string) =>
  `providerId=${encodeURIComponent(providerId)}&conversationId=${encodeURIComponent(conversationId)}&limit=${PAGE_SIZE}`;

const HEADER_ACTIVE_STATUSES: ReadonlySet<BotActivityState> = new Set([
  "working",
  "waiting_for_user",
  "waiting_for_approval",
  "error",
  "offline",
]);

function readBotDescription(bot: BotIdentity): string | null {
  const value = bot.metadata.description;
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function workingStatusCopy(bot: BotIdentity, gt: ReturnType<typeof useGT>): string {
  const grokActivity = bot.metadata.grokActivity;
  if (grokActivity === "thinking") return gt("Thinking…");
  if (grokActivity === "searching") return gt("Searching…");
  return gt("Working…");
}

/** A Bot's conversation in mattr's own page card: shared by every Bots provider. */
export function BotConversationView({ providerId, botId }: { providerId: string; botId: string }) {
  const gt = useGT();
  const m = useMessages();
  const config = useMattrApiConfig();
  const bots = useBotsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the Bots event stream open while the page is shown
  useEffect(() => {
    if (config === null) return;
    return retainBotsSync(config);
  }, [config]);

  const provider = bots.providers.find((entry) => entry.providerId === providerId);
  const bot = findBot(bots, providerId, botId);
  const conversations = useBotConversations(config, provider, bot);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const conversationId =
    selectedConversationId ??
    bot?.defaultConversationId ??
    conversations[0]?.conversationId ??
    null;

  const showHeaderStatus = bot !== undefined && HEADER_ACTIVE_STATUSES.has(bot.status);
  const providerLabel = provider?.displayName ?? gt("Bots");
  const botLabel = bot?.name ?? botId;
  // A provider with one Bot of the same name ("Grok Bot / Grok Bot") reads as a single crumb.
  const singleCrumb = botLabel.trim().toLowerCase() === providerLabel.trim().toLowerCase();
  const headerStatusDot = bot ? BOT_ACTIVITY_DOT[bot.status] : undefined;

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel={gt("Bot breadcrumb")} className="flex-1">
          {singleCrumb ? null : (
            <>
              <WorkspaceBreadcrumbItem className="shrink">
                <WorkspaceBreadcrumbText>{providerLabel}</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator>
                <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbSeparator>
            </>
          )}
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1 gap-2">
            {bot ? <BotAvatar bot={bot} size={18} activity={bot.status} /> : null}
            <h1 className="min-w-0">
              <WorkspaceBreadcrumbText>{botLabel}</WorkspaceBreadcrumbText>
            </h1>
            {showHeaderStatus && bot ? (
              <span
                data-bot-header-status={bot.status}
                className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
              >
                {headerStatusDot ? (
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      headerStatusDot,
                      bot.status === "working" && "animate-status-pulse",
                    )}
                  />
                ) : null}
                <span>{m(BOT_ACTIVITY_LABELS[bot.status])}</span>
              </span>
            ) : null}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <OfficialAppLink
          url={bot?.officialAppUrl ?? provider?.officialAppUrl ?? null}
          appName={provider?.displayName ?? null}
        />
      </WorkspacePageHeader>

      {/* Single child under WorkspacePageHeader so mattr's shell.css wraps the entire body in its rounded inset card. */}
      <div className="relative flex min-h-0 flex-1 flex-col bg-background">
        {!bots.loaded || config === null ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Spinner size="sm" aria-hidden="true" />
            <span role="status">
              <T>Loading…</T>
            </span>
          </div>
        ) : !provider || !bot ? (
          <BotUnavailable provider={provider} />
        ) : (
          <>
            {conversations.length > 1 ? (
              <div
                role="tablist"
                aria-label={gt("Conversations")}
                data-bot-conversation-tabs=""
                className="relative z-10 flex shrink-0 gap-1 overflow-x-auto border-b border-border/50 bg-background px-(--workspace-gutter-start) py-1.5 [scrollbar-width:none]"
              >
                {conversations.map((conversation, index) => {
                  const selected = conversation.conversationId === conversationId;
                  const title = conversation.title?.trim();
                  return (
                    <button
                      key={conversation.conversationId}
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      onClick={() => setSelectedConversationId(conversation.conversationId)}
                      className={cn(
                        "inline-flex h-6 max-w-64 shrink-0 cursor-pointer items-center rounded-md px-2 text-xs outline-hidden ring-ring transition-colors focus-visible:ring-2 focus-visible:ring-inset",
                        selected
                          ? "bg-accent font-medium text-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <span className="truncate">
                        {title
                          ? title
                          : index === 0
                            ? gt("Main chat")
                            : gt("Chat {number}", { number: index + 1 })}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
            {conversationId === null ? (
              <BotUnavailable provider={provider} />
            ) : (
              <BotConversationBody
                key={`${providerId}\u0000${conversationId}`}
                config={config}
                provider={provider}
                bot={bot}
                conversationId={conversationId}
                pending={bots.pending.filter(
                  (request) => request.providerId === providerId && request.botId === botId,
                )}
              />
            )}
          </>
        )}
      </div>
    </SidebarInset>
  );
}

function useBotConversations(
  config: MattrApiConfig | null,
  provider: BotProviderDescriptor | undefined,
  bot: BotIdentity | undefined,
): ReadonlyArray<BotConversation> {
  const [conversations, setConversations] = useState<ReadonlyArray<BotConversation>>([]);
  const providerId =
    provider?.capabilities.conversationDiscovery === true ? provider.providerId : null;
  const botId = bot?.remoteBotId ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the Bot's conversation list from the server when the Bot changes
  useEffect(() => {
    if (config === null || providerId === null || botId === null) return;
    const controller = new AbortController();
    void mattrApiRequest<BotConversationListResponse>(
      config,
      `/api/mattr/bots/conversations?providerId=${encodeURIComponent(providerId)}&botId=${encodeURIComponent(botId)}`,
      { signal: controller.signal },
    )
      .then((response) => setConversations(response.conversations))
      .catch(() => undefined);
    return () => controller.abort();
  }, [config, providerId, botId]);
  return config !== null && providerId !== null && botId !== null ? conversations : [];
}

function OfficialAppLink({ url, appName }: { url: string | null; appName: string | null }) {
  const gt = useGT();
  if (!url) return null;
  return (
    <div className="shrink-0 [-webkit-app-region:no-drag]">
      <Button
        size="xs"
        variant="ghost-muted"
        render={<a href={url} target="_blank" rel="noreferrer noopener" />}
      >
        <ExternalLinkIcon aria-hidden="true" />
        <span>
          {appName ? gt("Open in {name}", { name: appName }) : gt("Open in official app")}
        </span>
      </Button>
    </div>
  );
}

function BotUnavailable({ provider }: { provider: BotProviderDescriptor | undefined }) {
  const gt = useGT();
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>{gt("This Bot isn't available")}</EmptyTitle>
        <EmptyDescription>
          {provider?.status.detail ??
            gt("It may have been removed, or its connection is not ready yet.")}
        </EmptyDescription>
      </EmptyHeader>
      <Button size="sm" variant="outline" render={<Link to="/settings/addons" />}>
        <T>Add-on settings</T>
      </Button>
    </Empty>
  );
}

function BotConversationBody({
  config,
  provider,
  bot,
  conversationId,
  pending,
}: {
  config: MattrApiConfig;
  provider: BotProviderDescriptor;
  bot: BotIdentity;
  conversationId: string;
  pending: ReadonlyArray<BotPendingRequest>;
}) {
  const gt = useGT();
  const capabilities = provider.capabilities;
  const conversation = useBotConversation(config, provider.providerId, conversationId);
  const isWorking = bot.status === "working";
  const isEmpty =
    conversation.loaded &&
    conversation.messages.length === 0 &&
    pending.length === 0 &&
    !conversation.error &&
    !isWorking;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        data-bot-transcript-scroll=""
        className="topbar-scroll-fade scrollbar-gutter-both flex min-h-0 flex-1 flex-col-reverse overflow-y-auto"
      >
        {/* The composer's lane minus the scroll gutters, so both edges line up with the composer. */}
        <div
          className={cn(
            "chat-composer-lane w-full [--chat-lane-inset-end:calc(-1*var(--app-scrollbar-width))] [--chat-lane-inset-start:calc(-1*var(--app-scrollbar-width))]",
            isEmpty && "min-h-full",
          )}
        >
          <div
            data-bot-transcript-column=""
            className={cn(
              "mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-5 pt-10 pb-36",
              isEmpty && "min-h-full justify-center",
            )}
          >
            {!conversation.loaded ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Spinner size="sm" aria-hidden="true" />
                <span role="status">
                  <T>Loading conversation…</T>
                </span>
              </div>
            ) : isEmpty ? (
              <BotEmptyConversation bot={bot} provider={provider} />
            ) : (
              <>
                {conversation.olderCursor ? (
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    className="self-center"
                    disabled={conversation.loadingOlder}
                    onClick={() => void conversation.loadOlder()}
                  >
                    {conversation.loadingOlder ? <Spinner size="xs" aria-hidden="true" /> : null}
                    <T>Load earlier messages</T>
                  </Button>
                ) : null}
                {capabilities.history === "none" ? (
                  <p className="text-center text-xs text-muted-foreground">
                    <T>
                      History isn't available for this Bot. New messages appear here as they arrive.
                    </T>
                  </p>
                ) : null}
                {conversation.messages.map((message, index) => {
                  const previous = index > 0 ? conversation.messages[index - 1] : undefined;
                  const groupedWithPrevious =
                    previous !== undefined && previous.role === message.role;
                  return (
                    <BotMessageRow
                      key={message.clientNonce ?? message.remoteId}
                      message={message}
                      bot={bot}
                      groupedWithPrevious={groupedWithPrevious}
                    />
                  );
                })}
                {isWorking ? (
                  <div
                    className="flex items-center gap-2.5 px-1 py-1 text-sm text-muted-foreground"
                    role="status"
                    data-bot-working-indicator=""
                  >
                    <BotAvatar bot={bot} size={20} activity={bot.status} />
                    <span>{workingStatusCopy(bot, gt)}</span>
                  </div>
                ) : null}
                {conversation.error ? (
                  <div
                    className="rounded-xl border border-destructive/25 bg-destructive/8 px-3.5 py-2.5 text-sm text-destructive-foreground"
                    role="alert"
                  >
                    {conversation.error}
                  </div>
                ) : null}
                {pending.map((request) => (
                  <BotPendingRequestCard
                    key={request.requestId}
                    config={config}
                    request={request}
                    supported={
                      request.kind === "approval" ? capabilities.approvals : capabilities.questions
                    }
                    officialAppUrl={bot.officialAppUrl ?? provider.officialAppUrl}
                    appName={provider.displayName}
                  />
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      <div
        data-bot-composer-overlay="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 pt-1.5 sm:pt-2"
      >
        <div className="chat-composer-lane w-full">
          <div className="pointer-events-auto mx-auto w-full max-w-(--chat-content-max-width)">
            {capabilities.sendMessage ? (
              <BotComposer
                bot={bot}
                providerName={provider.displayName}
                creditSpendWarning={capabilities.creditSpendWarning}
                sending={conversation.sending}
                isWorking={isWorking}
                canCancel={capabilities.cancel}
                stopping={conversation.stopping}
                onSend={(text) => conversation.send(text, capabilities.creditSpendWarning)}
                onStop={() => void conversation.stop()}
              />
            ) : (
              <ComposerSurface.Shell>
                <ComposerSurface.Host>
                  <ComposerSurface.Main>
                    <p className="px-4 py-3 text-center text-xs text-muted-foreground">
                      {gt(
                        "Sending messages to {name} isn't supported here yet. Use the official app to reply.",
                        { name: bot.name },
                      )}
                    </p>
                  </ComposerSurface.Main>
                </ComposerSurface.Host>
              </ComposerSurface.Shell>
            )}
          </div>
          <div
            aria-hidden="true"
            className="h-[calc(env(safe-area-inset-bottom)+1rem)] sm:h-[calc(env(safe-area-inset-bottom)+1.25rem)]"
          />
        </div>
      </div>
    </div>
  );
}

function BotEmptyConversation({
  bot,
  provider,
}: {
  bot: BotIdentity;
  provider: BotProviderDescriptor;
}) {
  const gt = useGT();
  const description = readBotDescription(bot);
  return (
    <div
      data-bot-empty-state=""
      className="flex flex-col items-center justify-center gap-3 py-10 text-center"
    >
      <BotAvatar bot={bot} size={48} activity={bot.status} />
      <div className="flex flex-col items-center gap-1">
        <h2 className="text-lg font-medium tracking-tight text-foreground">{bot.name}</h2>
        <p className="max-w-sm text-sm text-muted-foreground">
          {description ??
            gt("Send a message to start chatting with {name} via {provider}.", {
              name: bot.name,
              provider: provider.displayName,
            })}
        </p>
      </div>
    </div>
  );
}

function useBotConversation(config: MattrApiConfig, providerId: string, conversationId: string) {
  const [messages, setMessages] = useState<ReadonlyArray<BotMessage>>([]);
  const [loaded, setLoaded] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the conversation's latest page and follows its live events from the server
  useEffect(() => {
    const controller = new AbortController();
    const target = { providerId, conversationId };
    const unsubscribe = subscribeBotEvents((event) =>
      setMessages((current) => applyBotConversationEvent(current, target, event)),
    );
    void mattrApiRequest<BotMessagesPage>(
      config,
      `/api/mattr/bots/messages?${messagesQuery(providerId, conversationId)}`,
      { signal: controller.signal },
    )
      .then((page) => {
        setMessages((current) => prependBotMessages(current, page.messages));
        setOlderCursor(page.olderCursor);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorText(cause));
          setLoaded(true);
        }
      });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [config, providerId, conversationId]);

  const loadOlder = async () => {
    if (!olderCursor) return;
    setLoadingOlder(true);
    try {
      const page = await mattrApiRequest<BotMessagesPage>(
        config,
        `/api/mattr/bots/messages?${messagesQuery(providerId, conversationId)}&cursor=${encodeURIComponent(olderCursor)}`,
      );
      setMessages((current) => prependBotMessages(current, page.messages));
      setOlderCursor(page.olderCursor);
    } catch (cause) {
      setError(errorText(cause));
    }
    setLoadingOlder(false);
  };

  const send = async (text: string, confirmUsage: boolean) => {
    const clientNonce = randomUUID();
    const optimistic: BotMessage = {
      remoteId: `pending:${clientNonce}`,
      conversationId,
      providerId,
      role: "user",
      attribution: "user-via-mattr",
      authorBotId: null,
      markdown: text,
      parts: [{ type: "markdown", text }],
      replyToId: null,
      attachments: [],
      artifacts: [],
      createdAt: new Date().toISOString(),
      seq: null,
      clientNonce,
      deliveryState: "pending",
    };
    setMessages((current) => upsertBotMessage(current, optimistic));
    setSending(true);
    setError(null);
    try {
      const { message } = await mattrApiRequest<{ readonly message: BotMessage }>(
        config,
        "/api/mattr/bots/messages",
        {
          method: "POST",
          body: {
            providerId,
            conversationId,
            text,
            clientNonce,
            ...(confirmUsage ? { confirmUsage } : {}),
          },
        },
      );
      setMessages((current) => upsertBotMessage(current, message));
      setSending(false);
      return true;
    } catch (cause) {
      setMessages((current) =>
        upsertBotMessage(current, { ...optimistic, deliveryState: "failed" }),
      );
      setError(errorText(cause));
      setSending(false);
      return false;
    }
  };

  // Best effort: a provider that can't stop the run says so, and the header links to its app.
  const stop = async () => {
    setStopping(true);
    setError(null);
    try {
      await mattrApiRequest(config, "/api/mattr/bots/cancel", {
        method: "POST",
        body: { providerId, conversationId },
      });
    } catch (cause) {
      setError(errorText(cause));
    }
    setStopping(false);
  };

  return {
    messages,
    loaded,
    olderCursor,
    loadingOlder,
    sending,
    stopping,
    error,
    loadOlder,
    send,
    stop,
  };
}

function errorText(cause: unknown) {
  if (isMattrApiError(cause)) return cause.detail ?? cause.code;
  return cause instanceof Error ? cause.message : String(cause);
}

function BotMessageRow({
  message,
  bot,
  groupedWithPrevious,
}: {
  message: BotMessage;
  bot: BotIdentity;
  groupedWithPrevious: boolean;
}) {
  const fromUser = message.role === "user";
  const trigger = message.role === "agent" ? null : scheduledTriggerDetail(message.markdown);
  if (trigger) return <BotScheduledTriggerRow message={message} detail={trigger.detail} />;
  if (fromUser) {
    return (
      <div className="group flex flex-col items-end gap-1" data-bot-message={message.role}>
        <div
          data-user-message-bubble=""
          className={cn(
            "relative min-w-0 max-w-[80%] rounded-2xl bg-message px-3.5 py-2.5 text-sm text-message-foreground",
            groupedWithPrevious && "rounded-tr-md",
            message.deliveryState === "pending" && "opacity-70",
          )}
        >
          {/* Remote Bot text is untrusted: rendered as markdown with raw HTML off, never executed. */}
          <ChatMarkdown
            text={message.markdown}
            cwd={undefined}
            className="text-message-foreground user-message-markdown"
            lineBreaks
            parseRawHtml={false}
          />
          {message.deliveryState === "failed" ? (
            <p className="mt-1 text-xs text-destructive-foreground">
              <T>Not sent</T>
            </p>
          ) : null}
        </div>
        <div className="flex items-center justify-end gap-1 pe-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          {message.markdown.trim().length > 0 ? (
            <MessageCopyButton text={message.markdown} variant="ghost" />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      className="group relative flex min-w-0 flex-col gap-1.5 px-1 py-0.5"
      data-bot-message={message.role}
    >
      {!groupedWithPrevious ? (
        <div className="flex items-center gap-2">
          <BotAvatar bot={bot} size={20} activity="idle" />
          <span className="text-xs font-medium text-muted-foreground">{bot.name}</span>
        </div>
      ) : null}
      <div className="min-w-0 text-sm">
        {/* Remote Bot text is untrusted: rendered as markdown with raw HTML off, never executed. */}
        <ChatMarkdown text={message.markdown} cwd={undefined} parseRawHtml={false} />
      </div>
      {message.markdown.trim().length > 0 ? (
        <div className="flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
          <MessageCopyButton text={message.markdown} variant="ghost" />
        </div>
      ) : null}
    </div>
  );
}

/** An automated prompt folded into one quiet, expandable event line instead of a chat bubble. */
function BotScheduledTriggerRow({ message, detail }: { message: BotMessage; detail: string }) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  return (
    <div
      className="flex flex-col gap-1.5"
      data-bot-message={message.role}
      data-bot-scheduled-trigger=""
    >
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="group/trigger flex min-w-0 cursor-pointer items-center gap-2 self-center rounded-md px-2 py-1 text-xs text-muted-foreground outline-hidden ring-ring transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset"
      >
        <ClockIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate">
          {detail.length > 0 ? gt("Scheduled check · {detail}", { detail }) : gt("Scheduled check")}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3 shrink-0 transition-transform", expanded && "rotate-90")}
        />
      </button>
      {expanded ? (
        <div className="min-w-0 rounded-xl border border-border/60 bg-muted/30 px-3.5 py-2.5 text-xs text-muted-foreground">
          {/* Remote Bot text is untrusted: rendered as markdown with raw HTML off, never executed. */}
          <ChatMarkdown text={message.markdown} cwd={undefined} parseRawHtml={false} />
        </div>
      ) : null}
    </div>
  );
}

function BotPendingRequestCard({
  config,
  request,
  supported,
  officialAppUrl,
  appName,
}: {
  config: MattrApiConfig;
  request: BotPendingRequest;
  supported: boolean;
  officialAppUrl: string | null;
  appName: string;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const respond = (response: unknown) => {
    setBusy(true);
    return mattrApiRequest(config, "/api/mattr/bots/respond", {
      method: "POST",
      body: { providerId: request.providerId, requestId: request.requestId, response },
    }).finally(() => setBusy(false));
  };
  return (
    <div
      className="rounded-2xl border bg-card p-4 text-sm shadow-xs"
      role="group"
      aria-label={request.title}
    >
      <p className="font-medium text-foreground">{request.title}</p>
      {request.detail ? <p className="mt-1 text-muted-foreground">{request.detail}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {!supported ? (
          officialAppUrl ? (
            <OfficialAppLink url={officialAppUrl} appName={appName} />
          ) : (
            <span className="text-xs text-muted-foreground">
              <T>Answer this in the official app.</T>
            </span>
          )
        ) : request.kind === "approval" ? (
          <>
            <Button
              size="xs"
              disabled={busy}
              onClick={() => void respond({ kind: "decision", decision: "approve" })}
            >
              {gt("Approve")}
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void respond({ kind: "decision", decision: "decline" })}
            >
              {gt("Decline")}
            </Button>
          </>
        ) : (
          request.options.map((option) => (
            <Button
              key={option.id}
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void respond({ kind: "option", optionId: option.id })}
            >
              {option.label}
            </Button>
          ))
        )}
      </div>
    </div>
  );
}

function BotComposer({
  bot,
  providerName,
  creditSpendWarning,
  sending,
  isWorking,
  canCancel,
  stopping,
  onSend,
  onStop,
}: {
  bot: BotIdentity;
  providerName: string;
  creditSpendWarning: boolean;
  sending: boolean;
  isWorking: boolean;
  canCancel: boolean;
  stopping: boolean;
  onSend: (text: string) => Promise<boolean>;
  onStop: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const [draft, setDraft] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const hasContent = draft.trim().length > 0;
  const showStop = canCancel && isWorking;
  const replaceSendWithStop = showStop && !hasContent && !sending;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    if (await onSend(text)) {
      setDraft("");
      textareaRef.current?.focus();
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      void submit();
      event.preventDefault();
    }
  };

  return (
    <form
      onSubmit={(event) => void submit(event)}
      data-bot-composer-form="true"
      className="w-full min-w-0"
    >
      <ComposerSurface.Shell>
        <ComposerSurface.Host>
          <ComposerSurface.Main>
            <div data-chat-composer-surface="true" className="rounded-2xl">
              <div data-chat-composer-body="true" className="relative px-4 pt-3.5 pb-2 sm:pt-4">
                <textarea
                  ref={textareaRef}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={onKeyDown}
                  rows={1}
                  placeholder={gt("Message {name}", { name: bot.name })}
                  aria-label={gt("Message {name}", { name: bot.name })}
                  className="field-sizing-content block max-h-52 min-h-[2lh] w-full resize-none bg-transparent text-base leading-relaxed text-foreground placeholder:text-muted-foreground/65 focus:outline-none sm:text-sm"
                />
              </div>

              <div
                data-chat-composer-footer="true"
                className="flex min-w-0 flex-nowrap items-center justify-end gap-2 px-2 pb-2"
              >
                <div className="flex min-w-0 flex-1 items-center justify-end gap-1 text-xs text-muted-foreground">
                  <span
                    data-bot-composer-chip=""
                    className="inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-foreground/80"
                  >
                    <BotAvatar bot={bot} size={16} activity={bot.status} />
                    <span className="truncate">{providerName}</span>
                  </span>
                  {isWorking ? (
                    <span className="truncate text-muted-foreground/80">
                      · {workingStatusCopy(bot, gt)}
                    </span>
                  ) : bot.status !== "idle" ? (
                    <span className="truncate text-muted-foreground/80">
                      · {m(BOT_ACTIVITY_LABELS[bot.status])}
                    </span>
                  ) : creditSpendWarning ? (
                    <span className="hidden truncate text-muted-foreground/75 sm:inline">
                      · {gt("Counts against plan usage")}
                    </span>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  {replaceSendWithStop ? (
                    <BotStopButton stopping={stopping} onStop={onStop} />
                  ) : (
                    <>
                      {showStop ? <BotStopButton stopping={stopping} onStop={onStop} /> : null}
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="submit"
                              data-bot-composer-send=""
                              disabled={sending || !hasContent}
                              aria-label={sending ? gt("Submitting message") : gt("Send")}
                              aria-busy={sending || undefined}
                              className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight hover:scale-105 hover:bg-message-action-hover active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none"
                            />
                          }
                        >
                          {sending ? (
                            <Spinner size="sm" aria-hidden="true" />
                          ) : (
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
                          )}
                        </TooltipTrigger>
                        <TooltipPopup>
                          {sending ? gt("Submitting message") : gt("Submit message")}
                        </TooltipPopup>
                      </Tooltip>
                    </>
                  )}
                </div>
              </div>
            </div>
          </ComposerSurface.Main>
        </ComposerSurface.Host>
      </ComposerSurface.Shell>
    </form>
  );
}

function BotStopButton({ stopping, onStop }: { stopping: boolean; onStop: () => void }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-bot-composer-stop=""
            disabled={stopping}
            onClick={onStop}
            aria-label={stopping ? gt("Stopping") : gt("Stop generation")}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none disabled:cursor-default disabled:opacity-64 disabled:hover:bg-destructive/90 [&_svg]:pointer-events-none"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>{stopping ? gt("Stopping…") : gt("Stop")}</TooltipPopup>
    </Tooltip>
  );
}
