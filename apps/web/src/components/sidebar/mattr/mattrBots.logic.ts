import type { BotIdentity, BotPendingRequest } from "@t3tools/contracts";

export function botKey(bot: Pick<BotIdentity, "providerId" | "remoteBotId">): string {
  return `${bot.providerId}:${bot.remoteBotId}`;
}

/**
 * A Bot belongs in Needs You only when it is blocked on the user: a waiting status, an open
 * pending request, or provider-reported asks. Unread briefings alone stay in Crew.
 */
export function botNeedsAttention(
  bot: BotIdentity,
  pending: ReadonlyArray<BotPendingRequest>,
): boolean {
  if (bot.status === "waiting_for_user" || bot.status === "waiting_for_approval") return true;
  if (
    pending.some(
      (request) => request.providerId === bot.providerId && request.botId === bot.remoteBotId,
    )
  ) {
    return true;
  }
  const asks = bot.metadata["pendingAsks"];
  return typeof asks === "number" && asks > 0;
}

function crewRank(bot: BotIdentity): number {
  if (bot.status === "working") return 0;
  if (bot.status === "error") return 1;
  if (bot.unreadCount > 0) return 2;
  return 3;
}

/** Working, failing and unread Bots first; the rest keep their provider order. */
export function rankCrew(bots: ReadonlyArray<BotIdentity>): ReadonlyArray<BotIdentity> {
  return bots
    .map((bot, index) => ({ bot, index }))
    .toSorted((a, b) => crewRank(a.bot) - crewRank(b.bot) || a.index - b.index)
    .map(({ bot }) => bot);
}

/** Drops a possessive owner prefix ("Christopher’s MacBook Pro" → "MacBook Pro"). */
export function shortHostLabel(label: string): string {
  const match = /^\S+?['’]s\s+(.+)$/u.exec(label.trim());
  return match?.[1]?.trim() || label.trim();
}

export type HostDotTone = "error" | "connecting" | "update" | null;

/** Healthy and up to date shows no dot; only a lost connection is red. */
export function hostDotTone(
  phase: string | undefined,
  updateStatus: string | undefined,
): HostDotTone {
  if (phase === "offline" || phase === "blocked" || phase === "backoff") return "error";
  if (phase === "connecting") return "connecting";
  if (updateStatus === "available" || updateStatus === "downloaded") return "update";
  return null;
}
