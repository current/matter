import type {
  AddonRuntimeStatus,
  BotAttachment,
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
import {
  ChevronRightIcon,
  CircleAlertIcon,
  ClockIcon,
  ExternalLinkIcon,
  UnplugIcon,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type RefObject,
} from "react";

import { ADDON_STATUS_LABELS } from "../../addons/addonRegistry";
import {
  MattrApiError,
  mattrApiRequest,
  useMattrApiConfig,
  type MattrApiConfig,
} from "../../addons/mattrApi";
import { isElectron } from "../../env";
import { useRenderedAppearance } from "../../hooks/useTheme";
import { formatBytes } from "../../lib/formatBytes";
import { cn, randomUUID } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { ComposerBanner } from "../chat/ComposerBanner";
import { ComposerBannerStack, type ComposerBannerStackItem } from "../chat/ComposerBannerStack";
import { ComposerSurface } from "../chat/ComposerSurface";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { FileChip } from "../contextChipParts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useClientSettings } from "../../hooks/useSettings";
import { formatChatTimestampTooltip, formatDayAwareTimestamp } from "../../timestampFormat";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BotAvatar } from "./BotAvatarRenderer";
import { BOT_ACTIVITY_LABELS } from "./botActivity";
import {
  applyBotConversationEvent,
  botActivityDetail,
  botPresence,
  confirmBotSend,
  prependBotMessages,
  botMessageRuns,
  otherBotAuthor,
  scheduledTriggerDetail,
  upsertBotMessage,
  type BotPresence,
} from "./botConversationModel";
import {
  findBot,
  reconnectBotProvider,
  retainBotsSync,
  subscribeBotEvents,
  useBotsState,
} from "./botsStore";

const PAGE_SIZE = 50;

const isMattrApiError = Schema.is(MattrApiError);

const messagesQuery = (providerId: string, conversationId: string) =>
  `providerId=${encodeURIComponent(providerId)}&conversationId=${encodeURIComponent(conversationId)}&limit=${PAGE_SIZE}`;

/** A short description only: some Bots store their whole system prompt here. */
function readBotDescription(bot: BotIdentity): string | null {
  const value = bot.metadata.description;
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= 200 ? text : null;
}

function workingStatusCopy(bot: BotIdentity, gt: ReturnType<typeof useGT>): string {
  const detail = botActivityDetail(bot);
  if (detail) return detail;
  const grokActivity = bot.metadata.grokActivity;
  if (grokActivity === "thinking") return gt("Thinking…");
  if (grokActivity === "searching") return gt("Searching…");
  return gt("Working…");
}

type ProviderReconnect = ReturnType<typeof useProviderReconnect>;

function useProviderReconnect(
  config: MattrApiConfig | null,
  provider: BotProviderDescriptor | undefined,
) {
  const [busy, setBusy] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const reconnect = async (): Promise<AddonRuntimeStatus | null> => {
    if (config === null || !provider) return null;
    setBusy(true);
    setUnreachable(false);
    const status = await reconnectBotProvider(config, provider);
    setBusy(false);
    setUnreachable(status === null);
    return status;
  };
  return { busy, unreachable, reconnect };
}

/** A Bot's conversation in mattr's own page card: shared by every Bots provider. */
export function BotConversationView({ providerId, botId }: { providerId: string; botId: string }) {
  const gt = useGT();
  const config = useMattrApiConfig();
  const bots = useBotsState();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds the Bots event stream open while the page is shown
  useEffect(() => {
    if (config === null) return;
    return retainBotsSync(config);
  }, [config]);

  const provider = bots.providers.find((entry) => entry.providerId === providerId);
  const bot = findBot(bots, providerId, botId);
  const reconnect = useProviderReconnect(config, provider);
  const conversations = useBotConversations(config, provider, bot);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const conversationId =
    selectedConversationId ??
    bot?.defaultConversationId ??
    conversations[0]?.conversationId ??
    null;
  const pending = bots.pending.filter(
    (request) => request.providerId === providerId && request.botId === botId,
  );

  const providerLabel = provider?.displayName ?? gt("Bots");
  const botLabel = bot?.name ?? botId;
  // A provider with one Bot of the same name ("Grok Bot / Grok Bot") reads as a single crumb.
  const singleCrumb = botLabel.trim().toLowerCase() === providerLabel.trim().toLowerCase();
  const presence = provider && bot ? botPresence(provider, bot, pending) : null;

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
            {bot ? <BotAvatar bot={bot} size={18} activity={bot.status} still /> : null}
            <h1 className="min-w-0">
              <WorkspaceBreadcrumbText>{botLabel}</WorkspaceBreadcrumbText>
            </h1>
            {provider && presence ? (
              <BotPresenceStatus provider={provider} presence={presence} reconnect={reconnect} />
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
          <BotUnavailable provider={provider} reconnect={reconnect} />
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
              <BotUnavailable provider={provider} reconnect={reconnect} />
            ) : (
              <BotConversationBody
                key={`${providerId}\u0000${conversationId}`}
                config={config}
                provider={provider}
                bot={bot}
                conversationId={conversationId}
                pending={pending}
                reconnect={reconnect}
              />
            )}
          </>
        )}
      </div>
    </SidebarInset>
  );
}

const PRESENCE_BADGE: Readonly<
  Record<BotPresence["kind"], "success" | "info" | "warning" | "error" | "outline">
> = {
  disconnected: "warning",
  connecting: "info",
  offline: "outline",
  "needs-you": "warning",
  working: "info",
  error: "error",
  ready: "success",
};

function BotPresenceStatus({
  provider,
  presence,
  reconnect,
}: {
  provider: BotProviderDescriptor;
  presence: BotPresence;
  reconnect: ProviderReconnect;
}) {
  const gt = useGT();
  const m = useMessages();
  // Like a native thread header: nothing to say while connected and idle.
  if (presence.kind === "ready") return null;
  const label =
    presence.kind === "disconnected"
      ? m(ADDON_STATUS_LABELS[provider.status.kind])
      : presence.kind === "connecting"
        ? m(ADDON_STATUS_LABELS.connecting)
        : presence.kind === "needs-you"
          ? gt("Needs you")
          : presence.kind === "working"
            ? m(BOT_ACTIVITY_LABELS.working)
            : presence.kind === "error"
              ? m(BOT_ACTIVITY_LABELS.error)
              : m(BOT_ACTIVITY_LABELS.offline);
  return (
    <span className="flex min-w-0 items-center gap-2" data-bot-header-status={presence.kind}>
      <Badge variant={PRESENCE_BADGE[presence.kind]}>
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-current" />
        {label}
      </Badge>
      {presence.kind === "working" && presence.detail ? (
        <span
          className="hidden min-w-0 truncate text-xs font-normal text-muted-foreground sm:inline"
          data-bot-header-activity=""
        >
          {presence.detail}
        </span>
      ) : null}
      {presence.kind === "disconnected" ? (
        <span className="shrink-0 [-webkit-app-region:no-drag]">
          <ReconnectButton reconnect={reconnect} size="xs" variant="ghost" />
        </span>
      ) : null}
    </span>
  );
}

function ReconnectButton({
  reconnect,
  size,
  variant,
}: {
  reconnect: ProviderReconnect;
  size: "xs" | "sm";
  variant: "ghost" | "default";
}) {
  return (
    <Button
      size={size}
      variant={variant}
      disabled={reconnect.busy}
      data-bot-reconnect=""
      onClick={() => void reconnect.reconnect()}
    >
      {reconnect.busy ? <Spinner size="xs" aria-hidden="true" /> : null}
      {reconnect.busy ? <T>Reconnecting…</T> : <T>Reconnect</T>}
    </Button>
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

function BotUnavailable({
  provider,
  reconnect,
}: {
  provider: BotProviderDescriptor | undefined;
  reconnect: ProviderReconnect;
}) {
  const gt = useGT();
  const disconnected = provider !== undefined && provider.status.kind !== "connected";
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyTitle>
          {disconnected
            ? gt("{name} isn't connected", { name: provider.displayName })
            : gt("This Bot isn't available")}
        </EmptyTitle>
        <EmptyDescription>
          {reconnect.unreachable
            ? gt("Couldn't reach the server. Try again.")
            : (provider?.status.detail ??
              gt("It may have been removed, or its connection is not ready yet."))}
        </EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap items-center justify-center gap-2">
        {disconnected ? (
          <ReconnectButton reconnect={reconnect} size="sm" variant="default" />
        ) : null}
        <Button size="sm" variant="outline" render={<Link to="/settings/addons" />}>
          <T>Add-on settings</T>
        </Button>
      </div>
    </Empty>
  );
}

function BotConversationBody({
  config,
  provider,
  bot,
  conversationId,
  pending,
  reconnect,
}: {
  config: MattrApiConfig;
  provider: BotProviderDescriptor;
  bot: BotIdentity;
  conversationId: string;
  pending: ReadonlyArray<BotPendingRequest>;
  reconnect: ProviderReconnect;
}) {
  const gt = useGT();
  const bots = useBotsState();
  const capabilities = provider.capabilities;
  const conversation = useBotConversation(config, provider.providerId, conversationId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState("");
  const connected = provider.status.kind === "connected";
  const isWorking = connected && bot.status === "working";
  const isEmpty =
    conversation.loaded && conversation.messages.length === 0 && pending.length === 0 && !isWorking;

  const send = (text: string) => {
    // The transcript scrolls bottom-up (column-reverse), so the newest message sits at 0.
    scrollRef.current?.scrollTo({ top: 0 });
    conversation.send(text, capabilities.creditSpendWarning);
  };

  const editFailed = (message: BotMessage) => {
    conversation.discard(message);
    setDraft((current) =>
      current.trim().length > 0 ? `${current}\n${message.markdown}` : message.markdown,
    );
    textareaRef.current?.focus();
  };

  const notices: Array<ComposerBannerStackItem> = [];
  if (!connected) {
    notices.push({
      id: "provider",
      variant: "warning",
      icon: <UnplugIcon />,
      title: gt("{name} isn't connected", { name: provider.displayName }),
      description: reconnect.unreachable
        ? gt("Couldn't reach the server. Try again.")
        : provider.status.detail,
      actions: <ReconnectButton reconnect={reconnect} size="xs" variant="ghost" />,
    });
  }
  if (conversation.error) {
    notices.push({
      id: "error",
      variant: "error",
      icon: <CircleAlertIcon />,
      title: conversation.error,
      actions: conversation.loadFailed ? (
        <Button size="xs" variant="ghost" onClick={() => void conversation.reload()}>
          <T>Retry</T>
        </Button>
      ) : undefined,
      dismissLabel: gt("Dismiss error"),
      onDismiss: conversation.dismissError,
    });
  }

  const disabledReason = connected
    ? null
    : gt("{name} isn't connected. Reconnect to send messages.", { name: provider.displayName });

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
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
                {botMessageRuns(conversation.messages).map((run) => {
                  const lead = run[0];
                  if (!lead) return null;
                  const runText = run
                    .map((message) =>
                      (otherBotAuthor(message)?.markdown ?? message.markdown).trim(),
                    )
                    .filter((text) => text.length > 0)
                    .join("\n\n");
                  const author = lead.authorBotId
                    ? findBot(bots, provider.providerId, lead.authorBotId)
                    : undefined;
                  return (
                    <div
                      key={lead.clientNonce ?? lead.remoteId}
                      className={cn(
                        "group/run flex min-w-0 flex-col",
                        lead.role === "user" && !lead.authorBotId ? "gap-1" : "gap-2",
                      )}
                      data-bot-message-run=""
                    >
                      {run.map((message, index) => (
                        <BotMessageRow
                          key={message.clientNonce ?? message.remoteId}
                          message={message}
                          bot={bot}
                          author={author}
                          first={index === 0}
                          last={index === run.length - 1}
                          runText={runText}
                          failure={
                            message.clientNonce === null
                              ? undefined
                              : conversation.failures[message.clientNonce]
                          }
                          onRetry={() =>
                            conversation.retry(message, capabilities.creditSpendWarning)
                          }
                          onEdit={() => editFailed(message)}
                        />
                      ))}
                    </div>
                  );
                })}
                {isWorking ? (
                  <div
                    className="flex h-6 min-w-0 items-center gap-2 px-1 text-sm text-muted-foreground"
                    role="status"
                    data-bot-working-indicator=""
                  >
                    <BotAvatar bot={bot} size={20} activity={bot.status} />
                    <span className="min-w-0 truncate">{workingStatusCopy(bot, gt)}</span>
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
                notices={notices}
                draft={draft}
                onDraftChange={setDraft}
                textareaRef={textareaRef}
                disabledReason={disabledReason}
                isWorking={isWorking}
                canCancel={capabilities.cancel}
                stopping={conversation.stopping}
                onSend={send}
                onStop={() => void conversation.stop()}
              />
            ) : (
              <ComposerSurface.Shell>
                <ComposerSurface.Host>
                  <ComposerBanner.Dock>
                    <ComposerBanner.Column>
                      <ComposerBannerStack items={notices} />
                    </ComposerBanner.Column>
                  </ComposerBanner.Dock>
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
        <p className="line-clamp-3 max-w-sm text-sm text-muted-foreground">
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

function fetchLatestPage(
  config: MattrApiConfig,
  providerId: string,
  conversationId: string,
  signal?: AbortSignal,
) {
  return mattrApiRequest<BotMessagesPage>(
    config,
    `/api/mattr/bots/messages?${messagesQuery(providerId, conversationId)}`,
    signal ? { signal } : {},
  );
}

function useBotConversation(config: MattrApiConfig, providerId: string, conversationId: string) {
  const [messages, setMessages] = useState<ReadonlyArray<BotMessage>>([]);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState<Readonly<Record<string, string>>>({});

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the conversation's latest page and follows its live events from the server
  useEffect(() => {
    const controller = new AbortController();
    const target = { providerId, conversationId };
    const unsubscribe = subscribeBotEvents((event) =>
      setMessages((current) => applyBotConversationEvent(current, target, event)),
    );
    void fetchLatestPage(config, providerId, conversationId, controller.signal)
      .then((page) => {
        setMessages((current) => prependBotMessages(current, page.messages));
        setOlderCursor(page.olderCursor);
        setLoaded(true);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(errorText(cause));
          setLoadFailed(true);
          setLoaded(true);
        }
      });
    return () => {
      controller.abort();
      unsubscribe();
    };
  }, [config, providerId, conversationId]);

  const reload = async () => {
    setError(null);
    setLoadFailed(false);
    try {
      const page = await fetchLatestPage(config, providerId, conversationId);
      setMessages((current) => prependBotMessages(current, page.messages));
      setOlderCursor(page.olderCursor);
    } catch (cause) {
      setError(errorText(cause));
      setLoadFailed(true);
    }
  };

  const dismissError = () => {
    setError(null);
    setLoadFailed(false);
  };

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

  const forgetFailure = (clientNonce: string) =>
    setFailures((current) => {
      if (!(clientNonce in current)) return current;
      return Object.fromEntries(Object.entries(current).filter(([nonce]) => nonce !== clientNonce));
    });

  const deliver = async (optimistic: BotMessage, clientNonce: string, confirmUsage: boolean) => {
    forgetFailure(clientNonce);
    setMessages((current) => upsertBotMessage(current, optimistic));
    try {
      const { message } = await mattrApiRequest<{ readonly message: BotMessage }>(
        config,
        "/api/mattr/bots/messages",
        {
          method: "POST",
          body: {
            providerId,
            conversationId,
            text: optimistic.markdown,
            clientNonce,
            ...(confirmUsage ? { confirmUsage } : {}),
          },
        },
      );
      setMessages((current) => confirmBotSend(current, message));
    } catch (cause) {
      setMessages((current) =>
        current.map((message) =>
          message.clientNonce === clientNonce && message.deliveryState === "pending"
            ? { ...message, deliveryState: "failed" }
            : message,
        ),
      );
      setFailures((current) => ({ ...current, [clientNonce]: errorText(cause) }));
    }
  };

  const send = (text: string, confirmUsage: boolean) => {
    const clientNonce = randomUUID();
    void deliver(
      {
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
      },
      clientNonce,
      confirmUsage,
    );
  };

  /** Sends a failed message again under the same nonce, so a late echo still reconciles. */
  const retry = (message: BotMessage, confirmUsage: boolean) => {
    if (message.clientNonce === null) return;
    void deliver(
      { ...message, deliveryState: "pending", createdAt: new Date().toISOString() },
      message.clientNonce,
      confirmUsage,
    );
  };

  const discard = (message: BotMessage) => {
    const { clientNonce } = message;
    if (clientNonce === null) return;
    forgetFailure(clientNonce);
    setMessages((current) => current.filter((entry) => entry.clientNonce !== clientNonce));
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
    loadFailed,
    olderCursor,
    loadingOlder,
    stopping,
    error,
    failures,
    reload,
    dismissError,
    loadOlder,
    send,
    retry,
    discard,
    stop,
  };
}

function errorText(cause: unknown) {
  if (isMattrApiError(cause)) return cause.detail ?? cause.code;
  return cause instanceof Error ? cause.message : String(cause);
}

function BotAttachmentChips({
  attachments,
  className,
}: {
  attachments: ReadonlyArray<BotAttachment>;
  className?: string;
}) {
  const gt = useGT();
  const theme = useRenderedAppearance();
  if (attachments.length === 0) return null;
  return (
    <div className={cn("flex flex-wrap gap-1", className)} data-bot-attachments="">
      {attachments.map((attachment) => {
        const size = attachment.sizeBytes === null ? "" : formatBytes(attachment.sizeBytes);
        const { url } = attachment;
        return (
          <FileChip
            key={attachment.id}
            name={attachment.name}
            size={size}
            isVideo={false}
            theme={theme}
            accessibleLabel={
              size
                ? gt("File attachment, {label}, {size}", { label: attachment.name, size })
                : gt("File attachment, {label}", { label: attachment.name })
            }
            tooltip={size ? `${attachment.name}\n${size}` : attachment.name}
            onOpen={url ? () => window.open(url, "_blank", "noopener,noreferrer") : undefined}
          />
        );
      })}
    </div>
  );
}

function BotMessageRow({
  message,
  bot,
  author,
  first,
  last,
  runText,
  failure,
  onRetry,
  onEdit,
}: {
  message: BotMessage;
  bot: BotIdentity;
  /** The other Bot that wrote this message, when it is one this provider lists. */
  author: BotIdentity | undefined;
  first: boolean;
  last: boolean;
  /** Text of the whole run of same-sender messages, copied from the run's last row. */
  runText: string;
  failure: string | undefined;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const gt = useGT();
  const otherBot = otherBotAuthor(message);
  const fromUser = message.role === "user" && otherBot === null;
  const trigger = message.role === "agent" ? null : scheduledTriggerDetail(message.markdown);
  const markdown = otherBot?.markdown ?? message.markdown;
  const hasText = markdown.trim().length > 0;
  if (trigger) return <BotScheduledTriggerRow message={message} detail={trigger.detail} />;
  if (fromUser) {
    return (
      <div
        className="flex flex-col items-end gap-1"
        data-bot-message={message.role}
        data-delivery-state={message.deliveryState}
      >
        <div
          data-user-message-bubble=""
          className={cn(
            "relative flex min-w-0 max-w-[80%] flex-col gap-2 rounded-2xl bg-message p-3 text-sm text-message-foreground",
            !first && "rounded-tr-md",
            !last && "rounded-br-md",
            message.deliveryState === "pending" && "opacity-70",
          )}
        >
          <BotAttachmentChips
            attachments={message.attachments}
            className="[&_[data-slot=context-chip]]:[--context-chip-message-ink:var(--context-chip-message)]"
          />
          {hasText ? (
            // Remote Bot text is untrusted: rendered as markdown with raw HTML off, never executed.
            <ChatMarkdown
              text={message.markdown}
              cwd={undefined}
              className="text-message-foreground user-message-markdown"
              lineBreaks
              parseRawHtml={false}
            />
          ) : null}
        </div>
        {message.deliveryState === "failed" ? (
          <BotSendFailure reason={failure} onRetry={onRetry} onEdit={onEdit} />
        ) : last ? (
          <BotMessageActions createdAt={message.createdAt} copyText={runText} align="end" />
        ) : null}
      </div>
    );
  }

  return (
    <div
      className="relative flex min-w-0 flex-col gap-1.5 px-1 py-0.5"
      data-bot-message={message.role}
      data-bot-other-author={otherBot ? "" : undefined}
    >
      {first ? (
        <div className="flex items-center gap-2">
          {otherBot ? (
            author ? (
              <BotAvatar bot={author} size={20} activity="idle" still />
            ) : (
              <span aria-hidden className="size-5 shrink-0 rounded-full bg-muted" />
            )
          ) : (
            <BotAvatar bot={bot} size={20} activity="idle" />
          )}
          <span className="text-xs font-medium text-muted-foreground">
            {otherBot ? (author?.name ?? otherBot.name ?? gt("Another Bot")) : bot.name}
          </span>
        </div>
      ) : null}
      {hasText ? (
        <div className="min-w-0 text-sm">
          {/* Remote Bot text is untrusted: rendered as markdown with raw HTML off, never executed. */}
          <ChatMarkdown text={markdown} cwd={undefined} parseRawHtml={false} />
        </div>
      ) : null}
      <BotAttachmentChips attachments={message.attachments} />
      {last ? (
        <BotMessageActions createdAt={message.createdAt} copyText={runText} align="start" />
      ) : null}
    </div>
  );
}

/** Time and copy, shown on hover like a native chat row. */
function BotMessageActions({
  createdAt,
  copyText,
  align,
}: {
  createdAt: string;
  copyText: string;
  align: "start" | "end";
}) {
  const m = useMessages();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  return (
    <div
      className={cn(
        "flex items-center gap-1.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/run:opacity-100",
        align === "end" ? "justify-end pe-1" : "ps-0",
      )}
    >
      <Tooltip>
        <TooltipTrigger render={<p className="text-xs text-muted-foreground tabular-nums" />}>
          {formatDayAwareTimestamp(createdAt, timestampFormat, undefined, undefined, m)}
        </TooltipTrigger>
        <TooltipPopup>{formatChatTimestampTooltip(createdAt, timestampFormat, m)}</TooltipPopup>
      </Tooltip>
      {copyText.length > 0 ? <MessageCopyButton text={copyText} variant="ghost" /> : null}
    </div>
  );
}

function BotSendFailure({
  reason,
  onRetry,
  onEdit,
}: {
  reason: string | undefined;
  onRetry: () => void;
  onEdit: () => void;
}) {
  const gt = useGT();
  return (
    <div
      className="flex max-w-[80%] flex-wrap items-center justify-end gap-x-1 gap-y-0.5 text-xs"
      data-bot-send-failure=""
    >
      <span
        className="inline-flex min-w-0 items-center gap-1.5 text-destructive-foreground"
        role="alert"
      >
        <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="min-w-0">
          {reason ? gt("Not sent: {reason}", { reason }) : gt("Not sent")}
        </span>
      </span>
      <Button size="xs" variant="ghost" onClick={onRetry}>
        <T>Retry</T>
      </Button>
      <Button size="xs" variant="ghost-muted" onClick={onEdit}>
        <T>Edit</T>
      </Button>
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
  notices,
  draft,
  onDraftChange,
  textareaRef,
  disabledReason,
  isWorking,
  canCancel,
  stopping,
  onSend,
  onStop,
}: {
  bot: BotIdentity;
  providerName: string;
  creditSpendWarning: boolean;
  notices: ReadonlyArray<ComposerBannerStackItem>;
  draft: string;
  onDraftChange: (draft: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  disabledReason: string | null;
  isWorking: boolean;
  canCancel: boolean;
  stopping: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const gt = useGT();
  const hasContent = draft.trim().length > 0;
  const disabled = disabledReason !== null;
  const showStop = canCancel && isWorking;
  const replaceSendWithStop = showStop && !hasContent;

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
    <ComposerSurface.Shell>
      <ComposerSurface.Host>
        <form
          onSubmit={submit}
          data-bot-composer-form="true"
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
                  placeholder={disabledReason ?? gt("Message {name}", { name: bot.name })}
                  aria-label={gt("Message {name}", { name: bot.name })}
                  className="field-sizing-content block max-h-52 min-h-[2lh] w-full resize-none bg-transparent text-base leading-relaxed text-foreground placeholder:text-muted-foreground/65 focus:outline-none disabled:cursor-not-allowed sm:text-sm"
                />
              </div>

              <div
                data-chat-composer-footer="true"
                className="flex min-w-0 flex-nowrap items-center justify-end gap-2 px-2 pb-2"
              >
                <div className="flex min-w-0 flex-1 items-center justify-end gap-1 text-xs text-muted-foreground">
                  <span
                    data-bot-composer-chip=""
                    className="min-w-0 truncate px-1.5 text-xs text-muted-foreground/70"
                  >
                    {gt("via {provider}", { provider: providerName })}
                  </span>
                  {creditSpendWarning ? (
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
                              disabled={disabled || !hasContent}
                              aria-label={gt("Send")}
                              className="relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full bg-message-action text-message-action-foreground shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:shadow-message-action/24 enabled:inset-shadow-control-highlight hover:scale-105 hover:bg-message-action-hover active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none"
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
                    </>
                  )}
                </div>
              </div>
            </div>
          </ComposerSurface.Main>
        </form>
      </ComposerSurface.Host>
    </ComposerSurface.Shell>
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
      <TooltipPopup>
        {stopping
          ? gt("Stopping…")
          : gt("Interrupt", { $context: "verb, stops the running agent" })}
      </TooltipPopup>
    </Tooltip>
  );
}
