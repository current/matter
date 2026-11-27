import type { ReactNode } from "react";

import { MarkdownImageAvailableWidthContext } from "../../threads/ThreadMarkdownImage";
import { MatterStreamingTextScope } from "./MatterStreamingText.matter";

/**
 * Stands in for the assistant message's image-width provider in ThreadFeed, so the Streaming text
 * hook there is a swapped tag rather than a re-indented block.
 */
export function MatterStreamingMessageScope(props: {
  readonly streaming: boolean;
  readonly imageWidth: number;
  readonly children: ReactNode;
}) {
  return (
    <MarkdownImageAvailableWidthContext value={props.imageWidth}>
      <MatterStreamingTextScope streaming={props.streaming}>
        {props.children}
      </MatterStreamingTextScope>
    </MarkdownImageAvailableWidthContext>
  );
}
