import type {
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
import { ArrowUpIcon, ExternalLinkIcon } from "lucide-react";
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  MattrApiError,
  mattrApiRequest,
  useMattrApiConfig,
  type MattrApiConfig,
} from "../../addons/mattrApi";
import { isElectron } from "../../env";
import { cn, randomUUID } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
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
  prependBotMessages,
  upsertBotMessage,
} from "./botConversationModel";
import { findBot, retainBotsSync, subscribeBotEvents, useBotsState } from "./botsStore";

const PAGE_SIZE = 50;

const isMattrApiError = Schema.is(MattrApiError);

const messagesQuery = (providerId: string, conversationId: string) =>
  `providerId=${encodeURIComponent(providerId)}&conversationId=${encodeURIComponent(conversationId)}&limit=${PAGE_SIZE}`;

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

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <WorkspaceBreadcrumb ariaLabel={gt("Bot breadcrumb")} className="flex-1">
          <WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbText>{provider?.displayName ?? gt("Bots")}</WorkspaceBreadcrumbText>
          </WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
          <WorkspaceBreadcrumbItem current className="min-w-10 flex-1 gap-2">
            {bot ? <BotAvatar bot={bot} size={18} activity={bot.status} /> : null}
            <h1 className="min-w-0">
              <WorkspaceBreadcrumbText>{bot?.name ?? botId}</WorkspaceBreadcrumbText>
            </h1>
            {bot ? (
              <Badge variant="outline" size="sm">
                {m(BOT_ACTIVITY_LABELS[bot.status])}
              </Badge>
            ) : null}
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        <OfficialAppLink url={bot?.officialAppUrl ?? provider?.officialAppUrl ?? null} />
      </WorkspacePageHeader>
      {!bots.loaded || config === null ? (
        <p className="p-6 text-sm text-muted-foreground" role="status">
          <T>Loading…</T>
        </p>
      ) : !provider || !bot ? (
        <BotUnavailable provider={provider} />
      ) : (
        <>
          {conversations.length > 1 ? (
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b px-(--workspace-gutter-start) py-1.5">
              {conversations.map((conversation) => (
                <Button
                  key={conversation.conversationId}
                  size="xs"
                  variant={conversation.conversationId === conversationId ? "secondary" : "ghost"}
                  onClick={() => setSelectedConversationId(conversation.conversationId)}
                >
                  {conversation.title ?? gt("Untitled conversation")}
                </Button>
              ))}
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

function OfficialAppLink({ url }: { url: string | null }) {
  if (!url) return null;
  return (
    <Button
      size="xs"
      variant="outline"
      render={<a href={url} target="_blank" rel="noreferrer noopener" />}
    >
      <ExternalLinkIcon />
      <T>Open in official app</T>
    </Button>
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
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="topbar-scroll-fade scrollbar-gutter-both flex min-h-0 flex-1 flex-col-reverse overflow-y-auto">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
          {conversation.olderCursor ? (
            <Button
              size="xs"
              variant="ghost"
              className="self-center"
              disabled={conversation.loadingOlder}
              onClick={() => void conversation.loadOlder()}
            >
              <T>Load earlier messages</T>
            </Button>
          ) : null}
          {capabilities.history === "none" ? (
            <p className="text-center text-xs text-muted-foreground">
              <T>History isn't available for this Bot. New messages appear here as they arrive.</T>
            </p>
          ) : null}
          {conversation.messages.map((message) => (
            <BotMessageRow
              key={message.clientNonce ?? message.remoteId}
              message={message}
              bot={bot}
            />
          ))}
          {conversation.error ? (
            <p className="text-sm text-destructive-foreground" role="alert">
              {conversation.error}
            </p>
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
            />
          ))}
        </div>
      </div>
      {capabilities.sendMessage ? (
        <BotComposer
          botName={bot.name}
          creditSpendWarning={capabilities.creditSpendWarning}
          sending={conversation.sending}
          onSend={(text) => conversation.send(text, capabilities.creditSpendWarning)}
        />
      ) : (
        <p className="shrink-0 border-t px-4 py-3 text-center text-xs text-muted-foreground">
          {gt(
            "Sending messages to {name} isn't supported here yet. Use the official app to reply.",
            {
              name: bot.name,
            },
          )}
        </p>
      )}
    </div>
  );
}

function useBotConversation(config: MattrApiConfig, providerId: string, conversationId: string) {
  const [messages, setMessages] = useState<ReadonlyArray<BotMessage>>([]);
  const [olderCursor, setOlderCursor] = useState<string | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
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
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorText(cause));
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
    } finally {
      setLoadingOlder(false);
    }
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
      return true;
    } catch (cause) {
      setMessages((current) =>
        upsertBotMessage(current, { ...optimistic, deliveryState: "failed" }),
      );
      setError(errorText(cause));
      return false;
    } finally {
      setSending(false);
    }
  };

  return { messages, olderCursor, loadingOlder, sending, error, loadOlder, send };
}

function errorText(cause: unknown) {
  if (isMattrApiError(cause)) return cause.detail ?? cause.code;
  return cause instanceof Error ? cause.message : String(cause);
}

function BotMessageRow({ message, bot }: { message: BotMessage; bot: BotIdentity }) {
  const fromUser = message.role === "user";
  return (
    <div className={cn("flex gap-3", fromUser && "justify-end")} data-bot-message={message.role}>
      {fromUser ? null : <BotAvatar bot={bot} size={24} activity={bot.status} className="mt-0.5" />}
      <div
        className={cn(
          "min-w-0 text-sm",
          fromUser
            ? "max-w-[85%] rounded-lg bg-secondary px-3 py-2 text-secondary-foreground"
            : "flex-1",
          message.deliveryState === "pending" && "opacity-70",
        )}
      >
        {/* Remote Bot text is untrusted: rendered as markdown with raw HTML off, never executed. */}
        <ChatMarkdown text={message.markdown} cwd={undefined} parseRawHtml={false} />
        {message.deliveryState === "failed" ? (
          <p className="mt-1 text-xs text-destructive-foreground">
            <T>Not sent</T>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function BotPendingRequestCard({
  config,
  request,
  supported,
  officialAppUrl,
}: {
  config: MattrApiConfig;
  request: BotPendingRequest;
  supported: boolean;
  officialAppUrl: string | null;
}) {
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  const respond = async (response: unknown) => {
    setBusy(true);
    try {
      await mattrApiRequest(config, "/api/mattr/bots/respond", {
        method: "POST",
        body: { providerId: request.providerId, requestId: request.requestId, response },
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border bg-card p-3 text-sm" role="group" aria-label={request.title}>
      <p className="font-medium text-foreground">{request.title}</p>
      {request.detail ? <p className="mt-1 text-muted-foreground">{request.detail}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {!supported ? (
          officialAppUrl ? (
            <OfficialAppLink url={officialAppUrl} />
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
  botName,
  creditSpendWarning,
  sending,
  onSend,
}: {
  botName: string;
  creditSpendWarning: boolean;
  sending: boolean;
  onSend: (text: string) => Promise<boolean>;
}) {
  const gt = useGT();
  const [draft, setDraft] = useState("");
  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    if (await onSend(text)) setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      void submit();
      event.preventDefault();
    }
  };
  return (
    <form onSubmit={(event) => void submit(event)} className="shrink-0 border-t px-4 py-3">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2">
        {creditSpendWarning ? (
          <p className="text-xs text-muted-foreground">
            {gt("Messages wake {name} and count against your plan's usage.", { name: botName })}
          </p>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={gt("Message {name}", { name: botName })}
            aria-label={gt("Message {name}", { name: botName })}
            className="flex-1"
          />
          <Button
            type="submit"
            size="icon-sm"
            disabled={sending || draft.trim().length === 0}
            aria-label={gt("Send")}
          >
            <ArrowUpIcon />
          </Button>
        </div>
      </div>
    </form>
  );
}
