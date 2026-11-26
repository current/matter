import type { BotActivityState, BotIdentity } from "@t3tools/contracts";
import { BotIcon } from "lucide-react";
import { Suspense, createElement, lazy, type ComponentType } from "react";

import { cn } from "../../lib/utils";

export interface BotAvatarProps {
  readonly bot: BotIdentity;
  /** Square size in pixels. */
  readonly size: number;
  readonly activity: BotActivityState;
  /** Shows the activity without motion, for dense lists such as the sidebar. */
  readonly still?: boolean;
  readonly className?: string;
}

/**
 * Providers with their own character art register a renderer here (Grok Bot's character, for
 * example). Everything else gets the neutral default, so one provider's look never leaks into
 * another's Bots.
 */
const renderers = new Map<string, ComponentType<BotAvatarProps>>();

/** @public Provider add-ons call this to draw their own avatar, such as an animated character. */
export function registerBotAvatarRenderer(
  providerId: string,
  renderer: ComponentType<BotAvatarProps>,
): () => void {
  renderers.set(providerId, renderer);
  return () => {
    if (renderers.get(providerId) === renderer) renderers.delete(providerId);
  };
}

function DefaultBotAvatar({ bot, size, className }: BotAvatarProps) {
  const avatar = bot.avatar;
  if (avatar?.kind === "data-url") {
    return (
      <img
        src={avatar.dataUrl}
        alt=""
        width={size}
        height={size}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }
  const initial = bot.name.trim().slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
        className,
      )}
    >
      {avatar?.kind === "icon" || initial === "" ? (
        <BotIcon className="size-[60%]" />
      ) : (
        <span className="font-medium leading-none" style={{ fontSize: Math.round(size * 0.45) }}>
          {initial}
        </span>
      )}
    </span>
  );
}

export function BotAvatar(props: BotAvatarProps) {
  return createElement(renderers.get(props.bot.providerId) ?? DefaultBotAvatar, props);
}

// Built in, but lazy: the character code loads only when a Grok Bot avatar first renders, which
// only happens while the Grok Bot add-on is on.
const LazyGrokBotAvatar = lazy(() =>
  import("./GrokBotAvatar").then((module) => ({ default: module.GrokBotAvatar })),
);

/** Blank disc while the character code loads, so no initial flashes in first. */
function GrokBotAvatarPlaceholder({ size, className }: BotAvatarProps) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn("inline-block shrink-0 rounded-full bg-muted", className)}
    />
  );
}

function GrokBotAvatarSlot(props: BotAvatarProps) {
  return (
    <Suspense fallback={<GrokBotAvatarPlaceholder {...props} />}>
      <LazyGrokBotAvatar {...props} />
    </Suspense>
  );
}

registerBotAvatarRenderer("grok-bot", GrokBotAvatarSlot);
