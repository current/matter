import { memo, type ReactNode } from "react";
import { SiriWaveVisual } from "../../island/SiriWave";
import { cn } from "~/lib/utils";

export const VoiceWaveform = memo(function VoiceWaveform(props: { level: number }) {
  return (
    <div
      aria-hidden
      className="flex h-6 min-w-0 flex-1 items-center justify-center overflow-hidden"
    >
      <SiriWaveVisual state="listening" level={props.level} width={76} height={24} />
    </div>
  );
});

/**
 * The capsule every dictation state renders in. Default matches the composer's send button
 * and insets its pill buttons; compact matches the `xs` buttons in text-field action rows.
 */
export function VoiceInputPill({
  children,
  tone = "default",
  size = "default",
}: {
  children: ReactNode;
  tone?: "default" | "error";
  size?: "default" | "compact" | undefined;
}) {
  return (
    <div
      data-slot="voice-input-pill"
      className={cn(
        "flex min-w-0 items-center gap-1.5 ring-1 ring-inset",
        size === "compact"
          ? // Phones give the capsule its own row so the field's buttons stay together below it.
            "h-7 rounded-md max-sm:order-first max-sm:basis-full sm:h-6"
          : "h-9 max-w-fit grow-[1.5] basis-0 rounded-full p-0.5 sm:h-8",
        tone === "error"
          ? "bg-destructive/6 text-destructive ring-destructive/24"
          : "bg-muted/48 ring-border",
      )}
    >
      {children}
    </div>
  );
}
