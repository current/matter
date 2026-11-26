import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  createChatCanvasStore,
  resolveChatCanvasModel,
  type ChatCanvasMeasurements,
} from "./canvasStore";
import type { ChatCanvasPreview } from "./chatCanvasLayout";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};
const otherThreadRef = { ...threadRef, threadId: ThreadId.make("thread-2") };
const measurements = (width: number, height = 900): ChatCanvasMeasurements => ({
  width,
  height,
  padding: 48,
  maxChatWidth: 768,
  maxHtmlPreviewWidth: 768,
  minChatWidth: 640,
  composerHeight: 180,
  timelineGutter: 0,
  findBar: null,
});
const preview: ChatCanvasPreview = {
  key: "browser:one",
  width: 320,
  position: null,
  source: { width: 1600, height: 1000 },
};

describe("chat canvas model", () => {
  it("shows the details card inline only where the canvas fits it beside the chat", () => {
    const resolve = (width: number, narrowestWidth = width) =>
      resolveChatCanvasModel({
        measurements: { ...measurements(width), narrowestWidth },
        detailsCardMeasurement: null,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      }).detailsCardMode;
    expect(resolve(1400)).toBe("inline");
    expect(resolve(900)).toBe("popover");
    expect(resolve(1400, 900)).toBe("popover");
  });

  it("moves the card into a popover when a preview below it leaves too little height", () => {
    const resolve = (fullContentHeight: number) =>
      resolveChatCanvasModel({
        measurements: measurements(1100, 300),
        detailsCardMeasurement: { threadRef, width: 280, fullContentHeight },
        threadRef,
        preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
        detailsCardInlineOpen: true,
      });
    const model = resolve(400);
    expect(model.layout.overlapsDetailsCard).toBe(true);
    expect(model.detailsCardMode).toBe("popover");
  });

  it("ignores a details card measured for another thread", () => {
    const model = resolveChatCanvasModel({
      measurements: measurements(1100, 300),
      detailsCardMeasurement: { threadRef: otherThreadRef, width: 280, fullContentHeight: 400 },
      threadRef,
      preview: { ...preview, position: { x: 760, y: 150 }, lastInteraction: "drag" },
      detailsCardInlineOpen: true,
    });
    expect(model.layout.overlapsDetailsCard).toBe(false);
    expect(model.detailsCardMode).toBe("inline");
  });

  it("keeps state identity when a measurement repeats", () => {
    const store = createChatCanvasStore();
    store.getState().setMeasurements(measurements(1400));
    const before = store.getState();
    store.getState().setMeasurements(measurements(1400));
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    const measured = store.getState();
    store.getState().measureDetailsCard({ threadRef, width: 280, fullContentHeight: 300 });
    expect(measured.measurements).toBe(before.measurements);
    expect(store.getState()).toBe(measured);
    store.getState().setMeasurements({ ...measurements(1400), narrowestWidth: 900 });
    expect(store.getState().measurements.narrowestWidth).toBe(900);
    expect(store.getState()).not.toBe(measured);
    const withTransition = store.getState();
    store.getState().setMeasurements({
      ...measurements(1400),
      narrowestWidth: 900,
      rightPanelTransition: { startWidth: 900, endWidth: 1400 },
    });
    expect(store.getState()).not.toBe(withTransition);
  });

  it("mounts the details card at its closing destination so chat widens monotonically without bouncing", () => {
    const startWidth = 510;
    const endWidth = 1050;
    const detailsCardMeasurement = { threadRef, width: 280, fullContentHeight: 320 };
    const finalModel = resolveChatCanvasModel({
      measurements: measurements(endWidth),
      detailsCardMeasurement,
      threadRef,
      preview: null,
      detailsCardInlineOpen: true,
    });
    let prevWidth = 0;
    let prevLeft = 0;
    for (let width = startWidth; width <= endWidth; width += 30) {
      const model = resolveChatCanvasModel({
        measurements: {
          ...measurements(width),
          narrowestWidth: startWidth,
          rightPanelTransition: { startWidth, endWidth },
        },
        detailsCardMeasurement,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      });
      expect(model.detailsCardMode).toBe("inline");
      expect(model.detailsCardPlacement).toMatchObject({
        x: finalModel.detailsCardPlacement!.x,
        pinnedLeft: true,
      });
      expect(model.layout.chat.width).toBeGreaterThanOrEqual(prevWidth);
      expect(model.layout.chat.width).toBeLessThanOrEqual(finalModel.layout.chat.width);
      expect(model.layout.chat.left).toBeGreaterThanOrEqual(prevLeft);
      expect(model.layout.chat.left).toBeLessThanOrEqual(finalModel.layout.chat.left);
      prevWidth = model.layout.chat.width;
      prevLeft = model.layout.chat.left;
    }
  });

  it("holds the details card boundary while a right panel opens so chat narrows monotonically", () => {
    const startWidth = 1050;
    const endWidth = 510;
    const detailsCardMeasurement = { threadRef, width: 280, fullContentHeight: 320 };
    const startModel = resolveChatCanvasModel({
      measurements: measurements(startWidth),
      detailsCardMeasurement,
      threadRef,
      preview: null,
      detailsCardInlineOpen: true,
    });
    let prevWidth = startModel.layout.chat.width;
    let prevLeft = startModel.layout.chat.left;
    for (let width = startWidth; width >= endWidth; width -= 30) {
      const model = resolveChatCanvasModel({
        measurements: {
          ...measurements(width),
          narrowestWidth: endWidth,
          rightPanelTransition: { startWidth, endWidth },
        },
        detailsCardMeasurement,
        threadRef,
        preview: null,
        detailsCardInlineOpen: true,
      });
      expect(model.detailsCardMode).toBe("popover");
      expect(model.detailsCardPlacement).toBeNull();
      expect(model.layout.chat.width).toBeLessThanOrEqual(prevWidth);
      expect(model.layout.chat.left).toBeLessThanOrEqual(prevLeft);
      prevWidth = model.layout.chat.width;
      prevLeft = model.layout.chat.left;
    }
  });

  it("keeps the card right-anchored when it already fits at both ends of a right panel slide", () => {
    const model = resolveChatCanvasModel({
      measurements: {
        ...measurements(1200),
        narrowestWidth: 1060,
        rightPanelTransition: { startWidth: 1060, endWidth: 1600 },
      },
      detailsCardMeasurement: { threadRef, width: 280, fullContentHeight: 320 },
      threadRef,
      preview: null,
      detailsCardInlineOpen: true,
    });
    expect(model.detailsCardMode).toBe("inline");
    expect(model.detailsCardPlacement?.pinnedLeft).toBeUndefined();
    expect(model.detailsCardPlacement?.x).toBe(1200 - 280 - 12);
  });
});
