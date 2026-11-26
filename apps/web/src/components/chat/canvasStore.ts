import type { ScopedThreadRef } from "@t3tools/contracts";
import { createStore } from "zustand";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import type { DetailsCardMeasurement } from "./ChatCanvasContext";
import {
  DETAILS_CARD_CLEARANCE,
  resolveChatCanvasLayout,
  type ChatCanvasPreview,
} from "./chatCanvasLayout";
import { resolveThreadDetailsCardLayout } from "./threadDetailsCardLayout";

interface CanvasEdges {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
}

export interface RightPanelWidthTransition {
  readonly startWidth: number;
  readonly endWidth: number;
}

export interface ChatCanvasMeasurements {
  readonly width: number;
  readonly narrowestWidth?: number;
  /** Canvas width at the start and end of an inline right-panel width transition. */
  readonly rightPanelTransition?: RightPanelWidthTransition | null;
  readonly height: number;
  readonly padding: number;
  readonly maxChatWidth: number;
  readonly maxHtmlPreviewWidth: number;
  readonly minChatWidth: number;
  readonly composerHeight: number;
  readonly timelineGutter: number;
  /** The find bar's box in canvas coordinates while it is shown. */
  readonly findBar: CanvasEdges | null;
}

interface ChatCanvasStoreState {
  readonly measurements: ChatCanvasMeasurements;
  readonly detailsCardMeasurement: DetailsCardMeasurement | null;
  readonly setMeasurements: (next: ChatCanvasMeasurements) => void;
  readonly measureDetailsCard: (next: DetailsCardMeasurement) => void;
}

const INITIAL_MEASUREMENTS: ChatCanvasMeasurements = {
  width: 0,
  height: 0,
  padding: 48,
  maxChatWidth: 768,
  maxHtmlPreviewWidth: 768,
  minChatWidth: 640,
  composerHeight: 0,
  timelineGutter: 0,
  findBar: null,
};

const sameEdges = (a: CanvasEdges | null, b: CanvasEdges | null) =>
  a === b ||
  (a !== null && b !== null && a.left === b.left && a.right === b.right && a.bottom === b.bottom);

const sameRightPanelTransition = (
  a: RightPanelWidthTransition | null | undefined,
  b: RightPanelWidthTransition | null | undefined,
) =>
  (a ?? null) === (b ?? null) ||
  (a != null && b != null && a.startWidth === b.startWidth && a.endWidth === b.endWidth);

const sameMeasurements = (a: ChatCanvasMeasurements, b: ChatCanvasMeasurements) =>
  a.width === b.width &&
  a.narrowestWidth === b.narrowestWidth &&
  sameRightPanelTransition(a.rightPanelTransition, b.rightPanelTransition) &&
  a.height === b.height &&
  a.padding === b.padding &&
  a.maxChatWidth === b.maxChatWidth &&
  a.maxHtmlPreviewWidth === b.maxHtmlPreviewWidth &&
  a.minChatWidth === b.minChatWidth &&
  a.composerHeight === b.composerHeight &&
  a.timelineGutter === b.timelineGutter &&
  sameEdges(a.findBar, b.findBar);

/**
 * One store per chat view: the canvas measures into it, and the chat view's
 * header controls derive the details card presentation from the same inputs.
 */
export const createChatCanvasStore = () =>
  createStore<ChatCanvasStoreState>()((set) => ({
    measurements: INITIAL_MEASUREMENTS,
    detailsCardMeasurement: null,
    setMeasurements: (next) =>
      set((state) => (sameMeasurements(state.measurements, next) ? state : { measurements: next })),
    measureDetailsCard: (next) =>
      set((state) => {
        const current = state.detailsCardMeasurement;
        return current?.threadRef.environmentId === next.threadRef.environmentId &&
          current.threadRef.threadId === next.threadRef.threadId &&
          current.width === next.width &&
          current.fullContentHeight === next.fullContentHeight
          ? state
          : { detailsCardMeasurement: next };
      }),
  }));

export type ChatCanvasStore = ReturnType<typeof createChatCanvasStore>;

export function resolveChatCanvasModel({
  measurements,
  detailsCardMeasurement,
  threadRef,
  preview,
  detailsCardInlineOpen,
}: {
  measurements: ChatCanvasMeasurements;
  detailsCardMeasurement: DetailsCardMeasurement | null;
  /** The thread whose details card sits on the canvas; other threads' measurements are stale. */
  threadRef: ScopedThreadRef | null;
  preview: ChatCanvasPreview | null;
  detailsCardInlineOpen: boolean;
}) {
  const container = { width: measurements.width, height: measurements.height };
  const { findBar } = measurements;
  const detailsCardTopInset = findBar?.bottom ?? 0;
  const lane = { padding: measurements.padding, minChatWidth: measurements.minChatWidth };
  const transition = measurements.rightPanelTransition ?? null;
  const narrowestWidth = measurements.narrowestWidth ?? measurements.width;
  // The preview avoids where an open inline card would sit, whether or not a
  // preview overlap has pushed the card itself into popover mode.
  const steadyPreferredDetailsCard = resolveThreadDetailsCardLayout({
    container,
    narrowestWidth,
    lane,
    frame: null,
    topInset: detailsCardTopInset,
  });
  // When a closing right panel widens the canvas enough for the docked card, mount it at its
  // destination x immediately so it reveals behind the retreating panel without a second reflow.
  const closingDetailsCard =
    steadyPreferredDetailsCard === null &&
    transition !== null &&
    transition.endWidth > transition.startWidth
      ? resolveThreadDetailsCardLayout({
          container: { width: transition.endWidth, height: container.height },
          narrowestWidth: transition.endWidth,
          lane,
          frame: null,
          topInset: detailsCardTopInset,
        })
      : null;
  // When an opening right panel hides a docked card that fit before the slide, keep its lane
  // boundary until the narrowing canvas passes it so chat doesn't jump wider before narrowing.
  const openingObstacleCard =
    steadyPreferredDetailsCard === null &&
    transition !== null &&
    transition.endWidth < transition.startWidth
      ? resolveThreadDetailsCardLayout({
          container: { width: transition.startWidth, height: container.height },
          narrowestWidth: transition.startWidth,
          lane,
          frame: null,
          topInset: detailsCardTopInset,
        })
      : null;
  const preferredDetailsCard = closingDetailsCard ?? steadyPreferredDetailsCard;
  // The canvas outlives thread switches, so a measurement only counts for the
  // thread whose card is shown now.
  const detailsCardMeasured =
    threadRef !== null &&
    detailsCardMeasurement !== null &&
    detailsCardMeasurement.threadRef.environmentId === threadRef.environmentId &&
    detailsCardMeasurement.threadRef.threadId === threadRef.threadId
      ? detailsCardMeasurement
      : null;
  const detailsCardForLane = preferredDetailsCard ?? openingObstacleCard;
  const detailsCard =
    detailsCardInlineOpen &&
    detailsCardForLane &&
    detailsCardMeasured?.width === detailsCardForLane.width &&
    detailsCardMeasured.fullContentHeight > 0
      ? {
          left: detailsCardForLane.x,
          right: detailsCardForLane.x + detailsCardForLane.width,
          bottom:
            detailsCardForLane.y +
            Math.min(detailsCardMeasured.fullContentHeight, detailsCardForLane.height),
        }
      : null;
  const layout = resolveChatCanvasLayout({
    container,
    preview,
    padding: measurements.padding,
    maxChatWidth: measurements.maxChatWidth,
    maxHtmlPreviewWidth: measurements.maxHtmlPreviewWidth,
    minChatWidth: measurements.minChatWidth,
    composerHeight: measurements.composerHeight,
    detailsCard,
    findBar,
  });
  const resolvedDetailsCardPlacement =
    closingDetailsCard !== null && transition !== null
      ? resolveThreadDetailsCardLayout({
          container: { width: transition.endWidth, height: container.height },
          narrowestWidth: transition.endWidth,
          lane,
          frame: layout.frame,
          overlapsDetailsCard: layout.overlapsDetailsCard,
          topInset: detailsCardTopInset,
        })
      : resolveThreadDetailsCardLayout({
          container,
          narrowestWidth,
          lane,
          frame: layout.frame,
          overlapsDetailsCard: layout.overlapsDetailsCard,
          topInset: detailsCardTopInset,
        });
  const detailsCardPlacement:
    | (NonNullable<typeof resolvedDetailsCardPlacement> & { readonly pinnedLeft?: true })
    | null =
    resolvedDetailsCardPlacement !== null && closingDetailsCard !== null
      ? { ...resolvedDetailsCardPlacement, pinnedLeft: true }
      : resolvedDetailsCardPlacement;
  const detailsCardMode: ThreadPanelPresentation = detailsCardPlacement ? "inline" : "popover";
  // Closed-form width threshold where insetEnd = max(0, width - laneClampWidth) matches
  // resolveChatCanvasLayout, letting CSS track a right-panel slide with zero 1-frame lag.
  const laneClampWidth =
    (closingDetailsCard !== null || openingObstacleCard !== null) &&
    detailsCard !== null &&
    preview === null
      ? Math.max(
          detailsCard.left - DETAILS_CARD_CLEARANCE + measurements.padding,
          (detailsCard.left - DETAILS_CARD_CLEARANCE) * 2 - measurements.maxChatWidth,
        )
      : null;
  return {
    container,
    lane,
    layout,
    laneClampWidth,
    detailsCardTopInset,
    preferredDetailsCard,
    detailsCardPlacement,
    detailsCardMode,
  };
}
