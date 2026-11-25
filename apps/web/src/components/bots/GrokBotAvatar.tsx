import type { BotActivityState } from "@t3tools/contracts";

import type { BotAvatarProps } from "./BotAvatarRenderer";
import {
  GrokBotCharacter,
  type GrokBotActivityState,
  type GrokBotCharacterSize,
} from "./GrokBotCharacter";

const GROK_ACTIVITY_STATES: ReadonlySet<string> = new Set<GrokBotActivityState>([
  "idle",
  "working",
  "thinking",
  "searching",
  "waiting",
  "error",
  "attention",
  "offline",
]);

const FROM_SHARED_STATE: Readonly<Record<BotActivityState, GrokBotActivityState>> = {
  idle: "idle",
  working: "working",
  waiting_for_user: "attention",
  waiting_for_approval: "attention",
  finished: "idle",
  suspended: "idle",
  error: "error",
  offline: "offline",
  unknown: "idle",
};

/** Grok Bot reports finer states (thinking, searching) than the shared model; prefer them. */
export function grokBotCharacterActivity({
  bot,
  activity,
}: Pick<BotAvatarProps, "bot" | "activity">): GrokBotActivityState {
  const reported = bot.metadata.grokActivity;
  if (
    activity === bot.status &&
    typeof reported === "string" &&
    GROK_ACTIVITY_STATES.has(reported)
  ) {
    return reported as GrokBotActivityState;
  }
  return FROM_SHARED_STATE[activity];
}

export function grokBotCharacterSize(size: number): GrokBotCharacterSize {
  if (size <= 20) return "xs";
  if (size <= 28) return "sm";
  if (size <= 40) return "md";
  return "lg";
}

/** Draws a Grok Bot Bot as its own character; loaded only once a Grok Bot avatar renders. */
export function GrokBotAvatar({ bot, size, activity, className }: BotAvatarProps) {
  const avatar = bot.avatar;
  return (
    <GrokBotCharacter
      name={bot.name}
      avatarDataUrl={avatar?.kind === "data-url" ? avatar.dataUrl : null}
      shape={avatar?.kind === "parametric" ? avatar.shape : null}
      color={avatar?.kind === "parametric" ? avatar.color : null}
      activityState={grokBotCharacterActivity({ bot, activity })}
      size={grokBotCharacterSize(size)}
      {...(className === undefined ? {} : { className })}
    />
  );
}
