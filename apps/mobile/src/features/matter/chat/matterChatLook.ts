/*
 * Matter "Tighter" chat look on mobile, mirroring matter/chat-messages.css: the user bubble's
 * 10px by 12px body and quieter 11px message times. Touch has no hover, so message actions stay
 * visible at their quiet ink, as the CSS's `hover: none` branch does.
 */
export const MATTER_USER_BUBBLE_BODY_CLASS = "gap-2 px-3 pb-2.5";
export const MATTER_MESSAGE_TIME_CLASS =
  "font-t3-medium text-3xs tabular-nums text-foreground-secondary opacity-70";
