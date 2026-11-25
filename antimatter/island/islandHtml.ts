import { SIRI_FLUID_DOTS_FRAG, SIRI_WAVE_FRAG, SIRI_WAVE_VERT } from "./siriWaveShaders.ts";

/**
 * Generates the self-contained HTML/CSS/JS document for the macOS Notch / mattr Island panel.
 * Loads instantaneously in Electron without booting the full web app, while embedding Lilt's
 * 1:1 Siri Wave (GLSL) WebGL shaders.
 */
export function buildIslandHtml(): string {
  const shadersJson = JSON.stringify({
    vert: SIRI_WAVE_VERT,
    wave: SIRI_WAVE_FRAG,
    fluidDots: SIRI_FLUID_DOTS_FRAG,
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>mattr Island</title>
<style>
  :root {
    --island-bg: #070709;
    --island-surface: rgba(255, 255, 255, 0.065);
    --island-surface-hover: rgba(255, 255, 255, 0.11);
    --island-surface-active: rgba(255, 255, 255, 0.16);
    --island-border: rgba(255, 255, 255, 0.09);
    --island-border-strong: rgba(255, 255, 255, 0.18);
    --island-fg: #f5f5f7;
    --island-fg-muted: rgba(245, 245, 247, 0.56);
    --island-fg-subtle: rgba(245, 245, 247, 0.38);
    --island-green: #34d399;
    --island-amber: #fbbf24;
    --island-blue: #60a5fa;
    --island-red: #f87171;
    --island-btn-primary-bg: #ffffff;
    --island-btn-primary-fg: #09090b;
    --island-ease: cubic-bezier(0.32, 0.72, 0, 1);
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: transparent;
    color: var(--island-fg);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }

  #stage {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    padding-top: 0;
    pointer-events: none;
  }

  #island-shell {
    position: relative;
    pointer-events: auto;
    background: var(--island-bg);
    color: var(--island-fg);
    border: 1px solid var(--island-border);
    border-top: none;
    border-radius: 0 0 22px 22px;
    box-shadow:
      0 18px 46px rgba(0, 0, 0, 0.52),
      0 4px 12px rgba(0, 0, 0, 0.34),
      inset 0 -1px 0 rgba(255, 255, 255, 0.05);
    overflow: hidden;
    transform-origin: top center;
    transition:
      width 280ms var(--island-ease),
      border-radius 280ms var(--island-ease),
      opacity 180ms ease,
      transform 240ms var(--island-ease);
    will-change: transform, opacity, width;
  }

  #island-shell.hidden {
    opacity: 0;
    transform: translateY(-10px) scale(0.94);
    pointer-events: none;
  }

  #island-shell.mode-pill {
    width: auto;
    min-width: 240px;
    max-width: 410px;
    border-radius: 0 0 18px 18px;
  }

  #island-shell.mode-card {
    width: 424px;
    border-radius: 0 0 24px 24px;
  }

  /* Compact notch pill */
  .pill-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px 10px 14px;
    min-height: 40px;
    cursor: pointer;
  }

  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    flex: none;
  }
  .status-dot.done { background: var(--island-green); box-shadow: 0 0 8px rgba(52, 211, 153, 0.55); }
  .status-dot.approval { background: var(--island-amber); box-shadow: 0 0 8px rgba(251, 191, 36, 0.55); }
  .status-dot.input { background: var(--island-blue); box-shadow: 0 0 8px rgba(96, 165, 250, 0.55); }
  .status-dot.running { background: var(--island-fg-muted); }

  .pill-label {
    font-size: 13px;
    font-weight: 560;
    letter-spacing: -0.01em;
    white-space: nowrap;
  }

  .pill-title {
    font-size: 13px;
    color: var(--island-fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 170px;
  }

  .pill-btn {
    margin-left: auto;
    border: none;
    background: rgba(255, 255, 255, 0.11);
    color: var(--island-fg);
    font: inherit;
    font-size: 12px;
    font-weight: 520;
    padding: 4px 10px;
    border-radius: 999px;
    cursor: pointer;
    transition: background 140ms ease;
    white-space: nowrap;
  }
  .pill-btn:hover { background: rgba(255, 255, 255, 0.19); }

  /* Card header */
  .card-inner {
    padding: 14px 16px 14px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .thread-picker-wrap {
    position: relative;
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 7px;
  }

  .thread-title-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    max-width: 100%;
    padding: 3px 7px 3px 0;
    border: none;
    background: transparent;
    color: var(--island-fg);
    font: inherit;
    font-size: 13.5px;
    font-weight: 600;
    letter-spacing: -0.012em;
    cursor: pointer;
    border-radius: 8px;
  }
  .thread-title-btn:hover { color: #ffffff; }
  .thread-title-text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread-chevron {
    color: var(--island-fg-subtle);
    font-size: 10px;
    flex: none;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }

  .icon-btn {
    width: 26px;
    height: 26px;
    border-radius: 999px;
    border: none;
    background: transparent;
    color: var(--island-fg-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
    padding: 0;
  }
  .icon-btn:hover {
    background: var(--island-surface-hover);
    color: var(--island-fg);
  }

  .badge-chip {
    font-size: 11px;
    font-weight: 560;
    padding: 2px 7px;
    border-radius: 999px;
    background: var(--island-surface);
    color: var(--island-fg-muted);
    white-space: nowrap;
  }
  .badge-chip.amber { background: rgba(251, 191, 36, 0.14); color: #fcd34d; }
  .badge-chip.blue { background: rgba(96, 165, 250, 0.14); color: #93c5fd; }
  .badge-chip.green { background: rgba(52, 211, 153, 0.14); color: #6ee7b7; }

  /* Thread switcher list */
  .thread-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 190px;
    overflow-y: auto;
    padding: 4px;
    border-radius: 12px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid var(--island-border);
  }
  .thread-list-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    text-align: left;
    border: none;
    background: transparent;
    color: var(--island-fg);
    font: inherit;
    font-size: 12.5px;
    padding: 7px 9px;
    border-radius: 8px;
    cursor: pointer;
    transition: background 120ms ease;
  }
  .thread-list-item:hover { background: var(--island-surface-hover); }
  .thread-list-item.active { background: var(--island-surface-active); }
  .thread-list-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .thread-list-meta {
    font-size: 11px;
    color: var(--island-fg-subtle);
    white-space: nowrap;
  }

  /* Conversation preview inside voice panel */
  .messages-box {
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 170px;
    overflow-y: auto;
    padding-right: 2px;
  }
  .messages-box::-webkit-scrollbar { width: 4px; }
  .messages-box::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.14);
    border-radius: 999px;
  }

  .user-bubble {
    align-self: flex-end;
    max-width: 88%;
    background: rgba(255, 255, 255, 0.09);
    color: rgba(245, 245, 247, 0.92);
    font-size: 12.5px;
    line-height: 1.42;
    padding: 6px 12px;
    border-radius: 14px;
    word-break: break-word;
    user-select: text;
  }

  .tool-meta {
    font-size: 11.5px;
    color: var(--island-fg-subtle);
    letter-spacing: -0.005em;
  }

  .assistant-text {
    font-size: 13px;
    line-height: 1.48;
    color: rgba(245, 245, 247, 0.9);
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }

  .empty-hint {
    font-size: 12.5px;
    color: var(--island-fg-subtle);
    padding: 4px 0;
  }

  /* Lilt Siri Wave stage */
  .voice-stage {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 4px 0 2px;
  }

  .transcript-pill {
    position: relative;
    max-width: 100%;
    padding: 5px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.075);
    font-size: 12.5px;
    line-height: 1.35;
    color: #ffffff;
    white-space: nowrap;
    overflow: hidden;
    mask-image: linear-gradient(to right, transparent 0%, black 14%, black 100%);
    -webkit-mask-image: linear-gradient(to right, transparent 0%, black 14%, black 100%);
    display: flex;
    justify-content: flex-end;
  }
  .transcript-pill .tentative { color: var(--island-fg-muted); }

  .wave-trigger {
    position: relative;
    width: 196px;
    height: 86px;
    border: none;
    background: transparent;
    padding: 0;
    margin: -4px 0;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border-radius: 999px;
    overflow: hidden;
    mask-image: radial-gradient(ellipse 50% 48% at 50% 50%, black 60%, transparent 100%);
    -webkit-mask-image: radial-gradient(ellipse 50% 48% at 50% 50%, black 60%, transparent 100%);
  }
  .wave-trigger:focus-visible {
    outline: 1px solid var(--island-border-strong);
  }
  #siri-wave-canvas {
    display: block;
    background: transparent;
    pointer-events: none;
    transition: opacity 280ms ease, transform 90ms linear;
  }

  .voice-error {
    font-size: 11.5px;
    color: var(--island-red);
    text-align: center;
  }

  /* Composer input row */
  .composer-row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-top: 2px;
  }

  .shortcut-hint {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: var(--island-fg-subtle);
    font: inherit;
    font-size: 12px;
    padding: 4px 6px 4px 2px;
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
    flex: none;
    transition: color 140ms ease, background 140ms ease;
  }
  .shortcut-hint:hover {
    color: var(--island-fg-muted);
    background: var(--island-surface);
  }
  .shortcut-hint.active {
    color: var(--island-fg);
  }

  .draft-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--island-fg);
    font: inherit;
    font-size: 13px;
    padding: 6px 4px;
    outline: none;
  }
  .draft-input::placeholder {
    color: var(--island-fg-subtle);
  }

  .send-circle-btn {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    border: none;
    background: rgba(255, 255, 255, 0.14);
    color: var(--island-fg-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex: none;
    transition: background 140ms ease, color 140ms ease, transform 120ms ease;
  }
  .send-circle-btn.ready {
    background: var(--island-btn-primary-bg);
    color: var(--island-btn-primary-fg);
  }
  .send-circle-btn:hover.ready { transform: scale(1.04); }
  .send-circle-btn:disabled { opacity: 0.45; cursor: default; }

  /* Question & Approval options (matching Dray screenshot 3) */
  .prompt-heading {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.35;
    color: var(--island-fg);
    margin: 0;
  }

  .approval-detail {
    font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.45;
    color: rgba(245, 245, 247, 0.82);
    background: rgba(255, 255, 255, 0.055);
    border: 1px solid var(--island-border);
    border-radius: 10px;
    padding: 8px 10px;
    max-height: 92px;
    overflow-y: auto;
    white-space: pre-wrap;
    word-break: break-word;
    user-select: text;
  }

  .option-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .option-card {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    text-align: left;
    border: 1px solid transparent;
    background: var(--island-surface);
    color: var(--island-fg);
    font: inherit;
    padding: 10px 12px;
    border-radius: 12px;
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
  }
  .option-card:hover {
    background: var(--island-surface-hover);
  }
  .option-card.selected {
    background: var(--island-surface-active);
    border-color: var(--island-border-strong);
  }

  .option-num {
    width: 16px;
    font-size: 12px;
    font-weight: 560;
    color: var(--island-fg-subtle);
    line-height: 1.4;
    flex: none;
    text-align: center;
  }
  .option-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .option-label {
    font-size: 13px;
    font-weight: 540;
    line-height: 1.35;
    word-break: break-word;
  }
  .option-desc {
    font-size: 11.5px;
    color: var(--island-fg-muted);
    line-height: 1.35;
  }

  .custom-answer-input {
    width: 100%;
    border: 1px solid var(--island-border);
    background: rgba(255, 255, 255, 0.045);
    color: var(--island-fg);
    font: inherit;
    font-size: 13px;
    padding: 9px 12px;
    border-radius: 11px;
    outline: none;
    transition: border-color 140ms ease, background 140ms ease;
  }
  .custom-answer-input:focus {
    border-color: var(--island-border-strong);
    background: rgba(255, 255, 255, 0.075);
  }
  .custom-answer-input::placeholder {
    color: var(--island-fg-subtle);
  }

  .card-footer {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding-top: 2px;
  }

  .ghost-btn {
    border: none;
    background: transparent;
    color: var(--island-fg-muted);
    font: inherit;
    font-size: 12.5px;
    font-weight: 520;
    padding: 6px 10px;
    border-radius: 999px;
    cursor: pointer;
    transition: color 120ms ease, background 120ms ease;
  }
  .ghost-btn:hover {
    color: var(--island-fg);
    background: var(--island-surface);
  }

  .primary-pill-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: none;
    background: var(--island-btn-primary-bg);
    color: var(--island-btn-primary-fg);
    font: inherit;
    font-size: 12.5px;
    font-weight: 600;
    padding: 7px 14px;
    border-radius: 999px;
    cursor: pointer;
    transition: opacity 120ms ease, transform 120ms ease;
  }
  .primary-pill-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .done-list {
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .done-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-radius: 11px;
    background: var(--island-surface);
    cursor: pointer;
    transition: background 120ms ease;
  }
  .done-item:hover { background: var(--island-surface-hover); }

  .flash-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 540;
    color: var(--island-green);
  }

  .mode-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .mode-pills {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    padding: 2px;
    border-radius: 999px;
    background: var(--island-surface);
    border: 1px solid var(--island-border);
  }
  .mode-pill-btn {
    border: none;
    background: transparent;
    color: var(--island-fg-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 540;
    padding: 3.5px 9px;
    border-radius: 999px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease;
  }
  .mode-pill-btn:hover {
    color: var(--island-fg);
  }
  .mode-pill-btn.active {
    background: var(--island-btn-primary-bg);
    color: var(--island-btn-primary-fg);
  }
  .handsfree-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: 1px solid var(--island-border);
    background: var(--island-surface);
    color: var(--island-fg-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 560;
    padding: 4px 9px;
    border-radius: 999px;
    cursor: pointer;
    transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
  }
  .handsfree-chip:hover {
    color: var(--island-fg);
    background: var(--island-surface-hover);
  }
  .handsfree-chip.live {
    background: rgba(52, 211, 153, 0.14);
    border-color: rgba(52, 211, 153, 0.42);
    color: var(--island-green);
  }
  .assistant-feed {
    display: flex;
    flex-direction: column;
    gap: 7px;
    max-height: 156px;
    overflow-y: auto;
    padding: 2px 0;
  }
  .assistant-reply {
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--island-fg);
    background: var(--island-surface);
    border: 1px solid var(--island-border);
    border-radius: 12px;
    padding: 8px 10px;
  }
  .assistant-reply.briefing {
    border-color: rgba(251, 191, 36, 0.35);
    background: rgba(251, 191, 36, 0.08);
  }
  .tool-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .tool-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10.5px;
    font-weight: 540;
    padding: 2px 7px;
    border-radius: 999px;
    background: rgba(52, 211, 153, 0.14);
    color: var(--island-green);
  }
  .tool-chip.fail {
    background: rgba(248, 113, 113, 0.14);
    color: var(--island-red);
  }
</style>
</head>
<body>
<div id="stage">
  <div id="island-shell" class="hidden mode-pill">
    <div id="island-content"></div>
  </div>
</div>
<script>
(() => {
  const SHADERS = ${shadersJson};
  const bridge = window.mattrIsland;
  const shell = document.getElementById("island-shell");
  const content = document.getElementById("island-content");

  let snapshot = null;
  let uiMode = "auto"; // "auto" | "voice" | "approval" | "question" | "done-list"
  let threadSwitcherOpen = false;
  let questionIndex = 0;
  let questionAnswers = {};
  let questionCustomText = "";
  let activeRequestId = null;
  let flashMessage = null;
  let flashTimer = null;
  let isHovering = false;
  let hoverExpandTimer = null;

  // Persistent WebGL state for 1:1 Lilt Siri Wave (GLSL)
  let waveGl = null;
  let waveProgs = null;
  let waveBuf = null;
  let waveRaf = 0;
  let waveCanvasEl = null;
  let waveStart = performance.now();
  let waveVariant = "wave";
  let waveState = "idle";
  let waveLevel = 0;
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function shortcutLabel() {
    const mode = snapshot?.settings?.shortcut ?? "control";
    if (mode === "option") return "⌥ to speak";
    if (mode === "command-shift-space") return "⌘⇧Space to speak";
    if (mode === "off") return "Click to speak";
    return "⌃ to speak";
  }

  function showFlash(text) {
    flashMessage = text;
    if (flashTimer) clearTimeout(flashTimer);
    render();
    flashTimer = setTimeout(() => {
      flashMessage = null;
      if (uiMode === "voice") {
        uiMode = "auto";
      }
      render();
    }, 1150);
  }

  function resolveEffectiveView() {
    if (flashMessage) return { kind: "flash" };
    if (!snapshot || !snapshot.settings.enabled) return { kind: "hidden" };

    const approvals = snapshot.pendingApprovals || [];
    const inputs = snapshot.pendingUserInputs || [];
    const done = snapshot.doneNotifications || [];
    const voiceActive = snapshot.voice && snapshot.voice.phase !== "idle";
    const assistant = snapshot.assistant;
    const assistantActive =
      assistant &&
      (assistant.phase === "listening" ||
        assistant.phase === "transcribing" ||
        assistant.phase === "thinking" ||
        assistant.phase === "acting" ||
        assistant.phase === "speaking");

    if (uiMode === "voice" || voiceActive) {
      return { kind: "voice" };
    }
    if (uiMode === "approval" && approvals.length > 0) {
      return { kind: "approval", approval: approvals[0] };
    }
    if (uiMode === "question" && inputs.length > 0) {
      return { kind: "question", input: inputs[0] };
    }
    if (uiMode === "done-list" && (done.length > 0 || approvals.length > 0 || inputs.length > 0)) {
      return { kind: "done-list" };
    }

    if (assistant?.handsFreeActive) {
      return { kind: "pill", pillKind: "voice-mode", assistant };
    }

    // Auto mode: only show passive notch notifications when enabled and main window is unfocused
    if (!snapshot.settings.showNotifications || snapshot.mainWindowFocused) {
      if (assistantActive) {
        return { kind: "pill", pillKind: "voice-mode", assistant };
      }
      return { kind: "hidden" };
    }

    const attentionCount = approvals.length + inputs.length;
    if (attentionCount > 0) {
      return {
        kind: "pill",
        pillKind: approvals.length > 0 ? "approval" : "input",
        count: attentionCount,
        approvals,
        inputs,
      };
    }
    if (done.length > 0) {
      return { kind: "pill", pillKind: "done", count: done.length, done };
    }
    return { kind: "hidden" };
  }

  function stopWaveLoop() {
    if (waveRaf) {
      cancelAnimationFrame(waveRaf);
      waveRaf = 0;
    }
  }

  function destroyWaveGl() {
    stopWaveLoop();
    if (waveGl) {
      try {
        if (waveProgs) {
          waveGl.deleteProgram(waveProgs.wave.prog);
          waveGl.deleteProgram(waveProgs.fluidDots.prog);
        }
        if (waveBuf) waveGl.deleteBuffer(waveBuf);
      } catch {}
    }
    waveGl = null;
    waveProgs = null;
    waveBuf = null;
    waveCanvasEl = null;
  }

  function compileProgram(gl, fragSrc) {
    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      return sh;
    };
    const prog = gl.createProgram();
    const vs = compile(gl.VERTEX_SHADER, SHADERS.vert);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return {
      prog,
      aPos: gl.getAttribLocation(prog, "aPos"),
      uRes: gl.getUniformLocation(prog, "iResolution"),
      uTime: gl.getUniformLocation(prog, "iTime"),
    };
  }

  function ensureWaveMounted() {
    const canvas = document.getElementById("siri-wave-canvas");
    if (!canvas) {
      destroyWaveGl();
      return;
    }
    if (canvas !== waveCanvasEl) {
      destroyWaveGl();
      waveCanvasEl = canvas;
      const gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
      if (!gl) return;
      waveGl = gl;
      waveProgs = {
        wave: compileProgram(gl, SHADERS.wave),
        fluidDots: compileProgram(gl, SHADERS.fluidDots),
      };
      waveBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, waveBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const px = Math.round(140 * 0.75 * dpr);
      canvas.width = px;
      canvas.height = px;
      gl.viewport(0, 0, px, px);
      waveStart = performance.now();
    }
    updateWaveVisuals();
    if (!waveRaf) {
      const frame = () => {
        if (!waveGl || !waveProgs || !waveCanvasEl || !document.body.contains(waveCanvasEl)) {
          stopWaveLoop();
          return;
        }
        const active = waveVariant === "fluid-dots" ? waveProgs.fluidDots : waveProgs.wave;
        waveGl.useProgram(active.prog);
        waveGl.bindBuffer(waveGl.ARRAY_BUFFER, waveBuf);
        waveGl.enableVertexAttribArray(active.aPos);
        waveGl.vertexAttribPointer(active.aPos, 2, waveGl.FLOAT, false, 0, 0);
        const t = prefersReducedMotion ? 1.2 : (performance.now() - waveStart) / 1000;
        waveGl.uniform2f(active.uRes, waveCanvasEl.width, waveCanvasEl.height);
        waveGl.uniform1f(active.uTime, t);
        waveGl.drawArrays(waveGl.TRIANGLES, 0, 3);
        if (!prefersReducedMotion) {
          waveRaf = requestAnimationFrame(frame);
        } else {
          waveRaf = 0;
        }
      };
      waveRaf = requestAnimationFrame(frame);
    }
  }

  function updateWaveVisuals() {
    const phase = snapshot?.voice?.phase ?? "idle";
    const assistant = snapshot?.assistant;
    const assistantPhase = assistant?.phase ?? "idle";
    const inputLevel = snapshot?.voice?.level ?? 0;
    const outputLevel = assistant?.outputLevel ?? 0;

    if (assistantPhase === "speaking" || assistant?.speaking) {
      waveState = "speaking";
      waveVariant = "wave";
      waveLevel = Math.max(0.18, outputLevel);
    } else if (assistantPhase === "thinking" || assistantPhase === "acting") {
      waveState = "thinking";
      waveVariant = "fluid-dots";
      waveLevel = 0.4;
    } else if (phase === "recording" || assistantPhase === "listening") {
      waveState = "listening";
      waveVariant = "wave";
      waveLevel = inputLevel;
    } else if (phase === "preparing") {
      waveState = "connecting";
      waveVariant = "fluid-dots";
      waveLevel = 0;
    } else if (
      phase === "transcribing" ||
      phase === "post-processing" ||
      assistantPhase === "transcribing"
    ) {
      waveState = "thinking";
      waveVariant = "fluid-dots";
      waveLevel = 0;
    } else if (phase === "error" || assistantPhase === "error") {
      waveState = "error";
      waveVariant = "wave";
      waveLevel = 0;
    } else {
      waveState = "idle";
      waveVariant = "wave";
      waveLevel = 0;
    }
    if (waveCanvasEl) {
      const stretch =
        waveState === "listening" || waveState === "speaking"
          ? 0.55 + 0.9 * Math.min(1, Math.max(0, waveLevel))
          : waveState === "idle" || waveState === "error"
            ? 0.45
            : 1;
      waveCanvasEl.style.opacity =
        waveState === "idle" ? "0.62" : waveState === "connecting" ? "0.78" : "1";
      waveCanvasEl.style.transform = "scaleY(" + stretch.toFixed(3) + ")";
      waveCanvasEl.style.filter =
        waveState === "error" ? "sepia(1) saturate(6) hue-rotate(-40deg)" : "";
    }
  }

  function selectedThread() {
    const list = snapshot?.recentThreads ?? [];
    if (list.length === 0) return null;
    return list.find((t) => t.key === snapshot.selectedThreadKey) ?? list[0];
  }

  function renderPill(view) {
    if (view.pillKind === "voice-mode") {
      const a = view.assistant || {};
      const statusText = a.muted
        ? "Voice Mode · Muted"
        : a.speaking || a.phase === "speaking"
          ? a.activeBriefingLabel || "Speaking…"
          : a.phase === "thinking" || a.phase === "acting"
            ? a.statusLabel || "Working…"
            : a.phase === "listening"
              ? "Listening…"
              : "Voice Mode";
      return \`
        <div class="pill-row" data-action="expand-voice">
          <span class="status-dot \${a.muted ? "approval" : "done"}"></span>
          <span class="pill-label">mattr</span>
          <span class="pill-title">\${escapeHtml(statusText)}</span>
          <button class="pill-btn" data-action="assistant-toggle-hands-free">\${a.handsFreeActive ? "Stop" : "Open"}</button>
        </div>
      \`;
    }
    if (view.pillKind === "done") {
      const items = view.done;
      if (items.length === 1) {
        const item = items[0];
        return \`
          <div class="pill-row" data-action="expand-done">
            <span class="status-dot done"></span>
            <span class="pill-label">Done</span>
            <span class="pill-title">\${escapeHtml(item.threadTitle)}</span>
            <button class="pill-btn" data-action="open-thread" data-env="\${escapeHtml(item.environmentId)}" data-thread="\${escapeHtml(item.threadId)}">Open in app</button>
          </div>
        \`;
      }
      return \`
        <div class="pill-row" data-action="expand-done">
          <span class="status-dot done"></span>
          <span class="pill-label">\${items.length} tasks finished</span>
          <button class="pill-btn" data-action="expand-done">View</button>
        </div>
      \`;
    }

    const total = view.count;
    if (total === 1 && view.approvals.length === 1) {
      const item = view.approvals[0];
      return \`
        <div class="pill-row" data-action="expand-approval">
          <span class="status-dot approval"></span>
          <span class="pill-label">Approve</span>
          <span class="pill-title">\${escapeHtml(item.threadTitle)}</span>
          <button class="pill-btn" data-action="expand-approval">Review</button>
        </div>
      \`;
    }
    if (total === 1 && view.inputs.length === 1) {
      const item = view.inputs[0];
      return \`
        <div class="pill-row" data-action="expand-question">
          <span class="status-dot input"></span>
          <span class="pill-label">Question</span>
          <span class="pill-title">\${escapeHtml(item.threadTitle)}</span>
          <button class="pill-btn" data-action="expand-question">Answer</button>
        </div>
      \`;
    }
    return \`
      <div class="pill-row" data-action="expand-attention">
        <span class="status-dot \${view.approvals.length > 0 ? "approval" : "input"}"></span>
        <span class="pill-label">\${total} tasks need attention</span>
        <button class="pill-btn" data-action="expand-attention">Open</button>
      </div>
    \`;
  }

  function renderDoneList() {
    const approvals = snapshot?.pendingApprovals ?? [];
    const inputs = snapshot?.pendingUserInputs ?? [];
    const done = snapshot?.doneNotifications ?? [];
    const rows = [];
    for (const a of approvals) {
      rows.push(\`
        <div class="done-item" data-action="expand-approval">
          <span class="status-dot approval"></span>
          <span class="thread-list-title">\${escapeHtml(a.threadTitle)}</span>
          <span class="badge-chip amber">Approve</span>
        </div>
      \`);
    }
    for (const q of inputs) {
      rows.push(\`
        <div class="done-item" data-action="expand-question">
          <span class="status-dot input"></span>
          <span class="thread-list-title">\${escapeHtml(q.threadTitle)}</span>
          <span class="badge-chip blue">Question</span>
        </div>
      \`);
    }
    for (const d of done) {
      rows.push(\`
        <div class="done-item" data-action="open-thread" data-env="\${escapeHtml(d.environmentId)}" data-thread="\${escapeHtml(d.threadId)}">
          <span class="status-dot done"></span>
          <span class="thread-list-title">\${escapeHtml(d.threadTitle)}</span>
          <span class="badge-chip green">Open</span>
        </div>
      \`);
    }
    return \`
      <div class="card-inner">
        <div class="card-header">
          <span style="font-size:13px;font-weight:600">Attention</span>
          <div class="header-actions">
            <button class="ghost-btn" style="padding:3px 8px;font-size:11.5px" data-action="dismiss-done">Clear</button>
            <button class="icon-btn" data-action="close-panel" title="Close">✕</button>
          </div>
        </div>
        <div class="done-list">\${rows.join("")}</div>
      </div>
    \`;
  }

  function renderApproval(approval) {
    const opts = approval.options.map((opt, idx) => \`
      <button class="option-card" data-action="pick-approval" data-decision="\${escapeHtml(opt.decision)}">
        <span class="option-num">\${idx + 1}</span>
        <span class="option-body">
          <span class="option-label">\${escapeHtml(opt.label)}</span>
          \${opt.warning ? \`<span class="option-desc">\${escapeHtml(opt.warning)}</span>\` : ""}
        </span>
      </button>
    \`).join("");

    return \`
      <div class="card-inner">
        <div class="card-header">
          <div class="thread-picker-wrap">
            <span class="status-dot approval"></span>
            <span class="thread-title-text" style="font-size:13px;font-weight:600">\${escapeHtml(approval.title)}</span>
            <span class="badge-chip">\${escapeHtml(approval.threadTitle)}</span>
          </div>
          <div class="header-actions">
            <button class="icon-btn" data-action="open-thread" data-env="\${escapeHtml(approval.environmentId)}" data-thread="\${escapeHtml(approval.threadId)}" title="Open in mattr">↗</button>
            <button class="icon-btn" data-action="close-panel" title="Close">✕</button>
          </div>
        </div>
        \${approval.detail ? \`<div class="approval-detail">\${escapeHtml(approval.detail)}</div>\` : ""}
        \${approval.reason ? \`<div class="tool-meta">\${escapeHtml(approval.reason)}</div>\` : ""}
        <div class="option-list">\${opts}</div>
      </div>
    \`;
  }

  function renderQuestion(input) {
    if (activeRequestId !== input.requestId) {
      activeRequestId = input.requestId;
      questionIndex = 0;
      questionAnswers = {};
      questionCustomText = "";
    }
    const q = input.questions[questionIndex] ?? input.questions[0];
    if (!q) return "";
    const currentAnswer = questionAnswers[q.id];
    const selectedSet = new Set(
      Array.isArray(currentAnswer) ? currentAnswer : currentAnswer ? [currentAnswer] : [],
    );

    const opts = q.options.map((opt, idx) => {
      const selected = !questionCustomText.trim() && selectedSet.has(opt.value);
      return \`
        <button class="option-card \${selected ? "selected" : ""}" data-action="pick-question-option" data-qid="\${escapeHtml(q.id)}" data-value="\${escapeHtml(opt.value)}" data-multi="\${q.multiSelect ? "1" : "0"}">
          <span class="option-num">\${idx + 1}</span>
          <span class="option-body">
            <span class="option-label">\${escapeHtml(opt.label)}</span>
            \${opt.description && opt.description !== opt.label ? \`<span class="option-desc">\${escapeHtml(opt.description)}</span>\` : ""}
          </span>
        </button>
      \`;
    }).join("");

    const canSend = Boolean(
      questionCustomText.trim().length > 0 ||
      (Array.isArray(currentAnswer) ? currentAnswer.length > 0 : Boolean(currentAnswer)),
    );
    const isLast = questionIndex >= input.questions.length - 1;

    return \`
      <div class="card-inner">
        <div class="card-header">
          <div class="thread-picker-wrap">
            <span class="status-dot input"></span>
            <span class="badge-chip">\${escapeHtml(input.threadTitle)}</span>
            \${input.questions.length > 1 ? \`<span class="badge-chip blue">\${questionIndex + 1}/\${input.questions.length}</span>\` : ""}
          </div>
          <div class="header-actions">
            <button class="icon-btn" data-action="open-thread" data-env="\${escapeHtml(input.environmentId)}" data-thread="\${escapeHtml(input.threadId)}" title="Open in mattr">↗</button>
            <button class="icon-btn" data-action="close-panel" title="Close">✕</button>
          </div>
        </div>
        <p class="prompt-heading">\${escapeHtml(q.question || q.header)}</p>
        <div class="option-list">\${opts}</div>
        \${q.allowCustomAnswer !== false ? \`
          <input
            id="question-custom-input"
            class="custom-answer-input"
            type="text"
            placeholder="Something else…"
            value="\${escapeHtml(questionCustomText)}"
          />
        \` : ""}
        <div class="card-footer">
          \${input.dismissible ? \`<button class="ghost-btn" data-action="dismiss-question">Skip</button>\` : ""}
          <button class="primary-pill-btn" data-action="submit-question" \${canSend ? "" : "disabled"}>
            <span>\${isLast ? "Send" : "Next"}</span>
            <span style="opacity:0.7">↵</span>
          </button>
        </div>
      </div>
    \`;
  }

  function renderVoicePanel() {
    const thread = selectedThread();
    const threads = snapshot?.recentThreads ?? [];
    const voice = snapshot?.voice ?? {
      phase: "idle",
      level: 0,
      previewCommitted: "",
      previewTentative: "",
      draftText: "",
      error: null,
      available: false,
    };
    const assistant = snapshot?.assistant ?? {
      mode: "smart",
      phase: "idle",
      handsFreeActive: false,
      muted: false,
      speaking: false,
      outputLevel: 0,
      liveTranscript: "",
      statusLabel: null,
      lastReply: null,
      lastToolResults: [],
      recentTurns: [],
      activeBriefingLabel: null,
      pendingBriefingCount: 0,
      error: null,
    };
    const activeMode = assistant.mode || "smart";
    const isDictationOnly = activeMode === "dictation";
    const showMessages = snapshot?.settings?.showMessages !== false;
    const isRecording = voice.phase === "recording" || assistant.phase === "listening";
    const isSpeaking = assistant.speaking || assistant.phase === "speaking";
    const isBusy =
      voice.phase === "preparing" ||
      voice.phase === "transcribing" ||
      voice.phase === "post-processing" ||
      assistant.phase === "transcribing" ||
      assistant.phase === "thinking" ||
      assistant.phase === "acting";
    const livePreview = (
      assistant.liveTranscript ||
      voice.previewCommitted + voice.previewTentative
    ).trim();
    const draftText = (voice.draftText || "").trim();
    const canSend = isDictationOnly
      ? (draftText.length > 0 || isRecording) && Boolean(thread)
      : draftText.length > 0 || isRecording;

    const statusDotClass =
      thread?.status === "approval"
        ? "approval"
        : thread?.status === "input"
          ? "input"
          : thread?.status === "done"
            ? "done"
            : "running";

    const switcherHtml = threadSwitcherOpen
      ? \`
        <div class="thread-list">
          \${threads.map((t) => \`
            <button class="thread-list-item \${thread && t.key === thread.key ? "active" : ""}" data-action="select-thread" data-key="\${escapeHtml(t.key)}">
              <span class="status-dot \${t.status === "approval" ? "approval" : t.status === "input" ? "input" : t.status === "done" ? "done" : "running"}"></span>
              <span class="thread-list-title">\${escapeHtml(t.title)}</span>
              \${t.projectTitle ? \`<span class="thread-list-meta">\${escapeHtml(t.projectTitle)}</span>\` : ""}
            </button>
          \`).join("")}
        </div>
      \`
      : "";

    let messagesHtml = "";
    if (!isDictationOnly && (assistant.recentTurns.length > 0 || assistant.lastReply)) {
      const turns = assistant.recentTurns.slice(-3);
      const blocks = turns.map((turn) => {
        if (turn.role === "user") {
          return \`<div class="user-bubble">\${escapeHtml(turn.text)}</div>\`;
        }
        const toolsHtml =
          turn.toolResults && turn.toolResults.length > 0
            ? \`<div class="tool-chip-row">\${turn.toolResults
                .map(
                  (tr) =>
                    \`<span class="tool-chip \${tr.ok ? "" : "fail"}">\${tr.ok ? "✓" : "!"} \${escapeHtml(tr.summary)}</span>\`,
                )
                .join("")}</div>\`
            : "";
        return \`<div class="assistant-reply \${turn.role === "briefing" ? "briefing" : ""}">\${escapeHtml(turn.text)}\${toolsHtml}</div>\`;
      });
      messagesHtml = \`<div class="assistant-feed">\${blocks.join("")}</div>\`;
    } else if (showMessages && thread) {
      const parts = [];
      if (thread.latestUserMessage) {
        parts.push(\`<div class="user-bubble">\${escapeHtml(thread.latestUserMessage)}</div>\`);
      }
      if (thread.toolCallCount > 0 || thread.isStreaming) {
        const meta = thread.isStreaming
          ? thread.toolCallCount > 0
            ? \`Working · \${thread.toolCallCount} tool call\${thread.toolCallCount === 1 ? "" : "s"}\`
            : "Working…"
          : \`\${thread.toolCallCount} tool call\${thread.toolCallCount === 1 ? "" : "s"}\`;
        parts.push(\`<div class="tool-meta">\${escapeHtml(meta)}</div>\`);
      }
      if (thread.latestAssistantMessage) {
        parts.push(\`<div class="assistant-text">\${escapeHtml(thread.latestAssistantMessage)}</div>\`);
      }
      if (parts.length > 0) {
        messagesHtml = \`<div class="messages-box">\${parts.join("")}</div>\`;
      }
    } else if (!isDictationOnly) {
      messagesHtml = \`<div class="empty-hint">Ask mattr to check threads, create projects, launch audits, or reply to a chat.</div>\`;
    } else if (!thread) {
      messagesHtml = \`<div class="empty-hint">Open a thread in mattr to dictate directly into it.</div>\`;
    }

    const hintText = isSpeaking
      ? "Speaking… tap to interrupt"
      : assistant.phase === "thinking" || assistant.phase === "acting"
        ? assistant.statusLabel || "Working…"
        : isRecording
          ? assistant.handsFreeActive
            ? "Hands-free listening…"
            : "Listening… tap again to send"
          : voice.phase === "preparing"
            ? "Starting mic…"
            : voice.phase === "transcribing" ||
                voice.phase === "post-processing" ||
                assistant.phase === "transcribing"
              ? "Transcribing…"
              : shortcutLabel();

    const modeBarHtml = \`
      <div class="mode-bar">
        <div class="mode-pills">
          <button class="mode-pill-btn \${activeMode === "smart" ? "active" : ""}" data-action="assistant-set-mode" data-mode="smart">Smart</button>
          <button class="mode-pill-btn \${activeMode === "assistant" ? "active" : ""}" data-action="assistant-set-mode" data-mode="assistant">Assistant</button>
          <button class="mode-pill-btn \${activeMode === "dictation" ? "active" : ""}" data-action="assistant-set-mode" data-mode="dictation">Dictate</button>
        </div>
        <div class="header-actions">
          <button class="handsfree-chip \${assistant.handsFreeActive ? "live" : ""}" data-action="assistant-toggle-hands-free" title="Hands-free conversational Voice Mode">
            <span class="status-dot \${assistant.handsFreeActive ? "done" : "running"}" style="width:6px;height:6px"></span>
            <span>\${assistant.handsFreeActive ? "Live" : "Voice Mode"}</span>
          </button>
          <button class="icon-btn" data-action="assistant-open-voice-mode-modal" title="Open full Voice Mode">⤢</button>
        </div>
      </div>
    \`;

    const combinedError = assistant.error || voice.error;

    return \`
      <div class="card-inner">
        <div class="card-header">
          <div class="thread-picker-wrap">
            <span class="status-dot \${statusDotClass}"></span>
            <button class="thread-title-btn" data-action="toggle-thread-switcher">
              <span class="thread-title-text">\${escapeHtml(isDictationOnly ? (thread?.title ?? "mattr") : "mattr Assistant")}</span>
              \${threads.length > 1 ? \`<span class="thread-chevron">▾</span>\` : ""}
            </button>
          </div>
          <div class="header-actions">
            \${(snapshot?.pendingApprovals?.length ?? 0) > 0
              ? \`<button class="badge-chip amber" style="border:none;cursor:pointer" data-action="expand-approval">Approve</button>\`
              : (snapshot?.pendingUserInputs?.length ?? 0) > 0
                ? \`<button class="badge-chip blue" style="border:none;cursor:pointer" data-action="expand-question">Question</button>\`
                : ""}
            \${thread ? \`<button class="icon-btn" data-action="open-thread" data-env="\${escapeHtml(thread.environmentId)}" data-thread="\${escapeHtml(thread.threadId)}" title="Open in mattr">↗</button>\` : ""}
            <button class="icon-btn" data-action="close-panel" title="Close (Esc)">✕</button>
          </div>
        </div>
        \${modeBarHtml}
        \${switcherHtml}
        \${messagesHtml}
        <div class="voice-stage">
          \${livePreview ? \`
            <div class="transcript-pill">
              <span>\${escapeHtml(assistant.liveTranscript || voice.previewCommitted)}<span class="tentative">\${escapeHtml(assistant.liveTranscript ? "" : voice.previewTentative)}</span></span>
            </div>
          \` : ""}
          <button class="wave-trigger" data-action="\${isSpeaking ? "assistant-barge-in" : "voice-toggle"}" title="\${escapeHtml(hintText)}">
            <canvas id="siri-wave-canvas" style="width:132px;height:132px"></canvas>
          </button>
          \${combinedError ? \`<div class="voice-error">\${escapeHtml(combinedError)}</div>\` : ""}
        </div>
        <div class="composer-row">
          <button class="shortcut-hint \${isRecording || isBusy || isSpeaking ? "active" : ""}" data-action="\${isSpeaking ? "assistant-barge-in" : "voice-toggle"}">
            \${escapeHtml(hintText)}
          </button>
          <input
            id="island-draft-input"
            class="draft-input"
            type="text"
            placeholder="\${isDictationOnly ? (thread ? "Reply…" : "") : "Ask mattr anything…"}"
            value="\${escapeHtml(voice.draftText || "")}"
            \${isDictationOnly && !thread ? "disabled" : ""}
          />
          <button
            class="send-circle-btn \${canSend ? "ready" : ""}"
            data-action="send-reply"
            \${canSend ? "" : "disabled"}
            title="\${isDictationOnly ? "Send reply (↵)" : "Ask mattr (↵)"}"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M8 12.5V3.5M8 3.5L4 7.5M8 3.5L12 7.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    \`;
  }

  let lastRenderedSignature = "";

  function render() {
    const view = resolveEffectiveView();
    if (view.kind === "hidden") {
      shell.className = "hidden mode-pill";
      destroyWaveGl();
      if (lastRenderedSignature !== "hidden") {
        content.innerHTML = "";
        lastRenderedSignature = "hidden";
      }
      bridge.setMousePassthrough(true);
      return;
    }

    if (view.kind === "flash") {
      shell.className = "mode-pill";
      destroyWaveGl();
      const sig = "flash:" + flashMessage;
      if (sig !== lastRenderedSignature) {
        content.innerHTML = \`<div class="flash-banner">✓ \${escapeHtml(flashMessage)}</div>\`;
        lastRenderedSignature = sig;
      }
      return;
    }

    if (view.kind === "pill") {
      shell.className = "mode-pill";
      destroyWaveGl();
      const html = renderPill(view);
      if (html !== lastRenderedSignature) {
        content.innerHTML = html;
        lastRenderedSignature = html;
      }
      return;
    }

    shell.className = "mode-card";
    if (view.kind === "done-list") {
      destroyWaveGl();
      const html = renderDoneList();
      if (html !== lastRenderedSignature) {
        content.innerHTML = html;
        lastRenderedSignature = html;
      }
      return;
    }
    if (view.kind === "approval") {
      destroyWaveGl();
      const html = renderApproval(view.approval);
      if (html !== lastRenderedSignature) {
        content.innerHTML = html;
        lastRenderedSignature = html;
      }
      return;
    }
    if (view.kind === "question") {
      destroyWaveGl();
      const html = renderQuestion(view.input);
      if (html !== lastRenderedSignature) {
        const prevFocused = document.activeElement?.id === "question-custom-input";
        content.innerHTML = html;
        lastRenderedSignature = html;
        if (prevFocused) document.getElementById("question-custom-input")?.focus();
      }
      return;
    }

    // Voice panel: avoid clobbering the live WebGL canvas or typing cursor on audio-level ticks
    const prevDraftInput = document.getElementById("island-draft-input");
    const draftFocused = document.activeElement === prevDraftInput;
    const selStart = prevDraftInput?.selectionStart ?? null;
    const selEnd = prevDraftInput?.selectionEnd ?? null;

    // Build structural signature ignoring high-frequency audio level
    const structuralSnapshot = {
      view: "voice",
      switcher: threadSwitcherOpen,
      thread: selectedThread(),
      threadsCount: snapshot?.recentThreads?.length ?? 0,
      approvals: snapshot?.pendingApprovals?.length ?? 0,
      inputs: snapshot?.pendingUserInputs?.length ?? 0,
      showMessages: snapshot?.settings?.showMessages,
      shortcut: snapshot?.settings?.shortcut,
      voicePhase: snapshot?.voice?.phase,
      previewCommitted: snapshot?.voice?.previewCommitted,
      previewTentative: snapshot?.voice?.previewTentative,
      draftText: snapshot?.voice?.draftText,
      voiceError: snapshot?.voice?.error,
      assistantMode: snapshot?.assistant?.mode,
      assistantPhase: snapshot?.assistant?.phase,
      assistantHandsFree: snapshot?.assistant?.handsFreeActive,
      assistantMuted: snapshot?.assistant?.muted,
      assistantSpeaking: snapshot?.assistant?.speaking,
      assistantTranscript: snapshot?.assistant?.liveTranscript,
      assistantStatus: snapshot?.assistant?.statusLabel,
      assistantTurns: snapshot?.assistant?.recentTurns?.slice(-3),
      assistantError: snapshot?.assistant?.error,
    };
    const sig = JSON.stringify(structuralSnapshot);
    if (sig !== lastRenderedSignature) {
      content.innerHTML = renderVoicePanel();
      lastRenderedSignature = sig;
      if (draftFocused) {
        const nextInput = document.getElementById("island-draft-input");
        if (nextInput) {
          nextInput.focus();
          if (selStart !== null && selEnd !== null) {
            try { nextInput.setSelectionRange(selStart, selEnd); } catch {}
          }
        }
      }
    }
    ensureWaveMounted();
  }

  function submitCurrentQuestion() {
    const input = snapshot?.pendingUserInputs?.[0];
    if (!input) return;
    const q = input.questions[questionIndex] ?? input.questions[0];
    if (!q) return;
    const nextAnswers = { ...questionAnswers };
    if (questionCustomText.trim()) {
      nextAnswers[q.id] = questionCustomText.trim();
    }
    if (!nextAnswers[q.id]) return;
    questionAnswers = nextAnswers;
    if (questionIndex < input.questions.length - 1) {
      questionIndex += 1;
      questionCustomText = "";
      render();
      return;
    }
    bridge.sendAction({
      type: "respond-user-input",
      environmentId: input.environmentId,
      threadId: input.threadId,
      requestId: input.requestId,
      answers: questionAnswers,
    });
    questionIndex = 0;
    questionAnswers = {};
    questionCustomText = "";
    activeRequestId = null;
    uiMode = "auto";
    showFlash("Sent");
  }

  function submitVoiceReply() {
    const mode = snapshot?.assistant?.mode || "smart";
    const inputEl = document.getElementById("island-draft-input");
    const text = (inputEl?.value ?? snapshot?.voice?.draftText ?? "").trim();
    if (snapshot?.voice?.phase === "recording") {
      bridge.sendAction({ type: "voice-stop" });
      return;
    }
    if (!text) return;
    if (mode !== "dictation") {
      bridge.sendAction({ type: "assistant-submit-text", text });
      bridge.sendAction({ type: "update-draft", text: "" });
      threadSwitcherOpen = false;
      return;
    }
    const thread = selectedThread();
    if (!thread) return;
    bridge.sendAction({
      type: "send-reply",
      environmentId: thread.environmentId,
      threadId: thread.threadId,
      text,
    });
    threadSwitcherOpen = false;
    showFlash("Sent");
  }

  function closeIsland() {
    threadSwitcherOpen = false;
    uiMode = "auto";
    bridge.sendAction({ type: "voice-cancel" });
    bridge.sendAction({ type: "close-panel" });
    render();
  }

  // Click delegation
  shell.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "open-thread") {
      event.stopPropagation();
      uiMode = "auto";
      bridge.sendAction({
        type: "open-thread",
        environmentId: target.dataset.env,
        threadId: target.dataset.thread,
      });
      render();
      return;
    }
    if (action === "expand-done") {
      uiMode = "done-list";
      bridge.focusWindow();
      render();
      return;
    }
    if (action === "expand-approval") {
      uiMode = "approval";
      bridge.focusWindow();
      render();
      return;
    }
    if (action === "expand-question") {
      uiMode = "question";
      bridge.focusWindow();
      render();
      return;
    }
    if (action === "expand-attention") {
      if ((snapshot?.pendingApprovals?.length ?? 0) > 0) uiMode = "approval";
      else if ((snapshot?.pendingUserInputs?.length ?? 0) > 0) uiMode = "question";
      else uiMode = "done-list";
      bridge.focusWindow();
      render();
      return;
    }
    if (action === "dismiss-done") {
      bridge.sendAction({ type: "dismiss-done" });
      uiMode = "auto";
      render();
      return;
    }
    if (action === "close-panel") {
      closeIsland();
      return;
    }
    if (action === "toggle-thread-switcher") {
      threadSwitcherOpen = !threadSwitcherOpen;
      render();
      return;
    }
    if (action === "select-thread") {
      threadSwitcherOpen = false;
      bridge.sendAction({ type: "select-thread", threadKey: target.dataset.key });
      render();
      return;
    }
    if (action === "voice-toggle") {
      if (!snapshot?.voice?.available) {
        bridge.sendAction({ type: "open-voice-settings" });
        return;
      }
      bridge.sendAction({ type: "voice-toggle" });
      return;
    }
    if (action === "expand-voice") {
      uiMode = "voice";
      bridge.focusWindow();
      render();
      return;
    }
    if (action === "assistant-set-mode") {
      const mode = target.dataset.mode;
      if (mode) {
        bridge.sendAction({ type: "assistant-set-mode", mode });
      }
      return;
    }
    if (action === "assistant-toggle-hands-free") {
      event.stopPropagation();
      bridge.sendAction({ type: "assistant-toggle-hands-free" });
      return;
    }
    if (action === "assistant-barge-in") {
      bridge.sendAction({ type: "assistant-barge-in" });
      return;
    }
    if (action === "assistant-open-voice-mode-modal") {
      uiMode = "auto";
      bridge.sendAction({ type: "assistant-open-voice-mode-modal" });
      render();
      return;
    }
    if (action === "send-reply") {
      submitVoiceReply();
      return;
    }
    if (action === "pick-approval") {
      const approval = snapshot?.pendingApprovals?.[0];
      if (!approval) return;
      const decision = target.dataset.decision;
      bridge.sendAction({
        type: "respond-approval",
        environmentId: approval.environmentId,
        threadId: approval.threadId,
        requestId: approval.requestId,
        decision,
      });
      uiMode = "auto";
      const label =
        decision === "accept"
          ? "Allowed once"
          : decision === "acceptAlways"
            ? "Always allowed"
            : decision === "acceptForSession"
              ? "Allowed for session"
              : "Denied";
      showFlash(label);
      return;
    }
    if (action === "pick-question-option") {
      const qid = target.dataset.qid;
      const value = target.dataset.value;
      const multi = target.dataset.multi === "1";
      questionCustomText = "";
      if (multi) {
        const cur = Array.isArray(questionAnswers[qid]) ? [...questionAnswers[qid]] : [];
        const i = cur.indexOf(value);
        if (i >= 0) cur.splice(i, 1);
        else cur.push(value);
        questionAnswers[qid] = cur;
        render();
      } else {
        questionAnswers[qid] = value;
        render();
        setTimeout(() => submitCurrentQuestion(), 140);
      }
      return;
    }
    if (action === "dismiss-question") {
      const input = snapshot?.pendingUserInputs?.[0];
      if (!input) return;
      bridge.sendAction({
        type: "dismiss-user-input",
        environmentId: input.environmentId,
        threadId: input.threadId,
        requestId: input.requestId,
      });
      uiMode = "auto";
      render();
      return;
    }
    if (action === "submit-question") {
      submitCurrentQuestion();
      return;
    }
  });

  // Live input sync
  shell.addEventListener("input", (event) => {
    if (event.target.id === "island-draft-input") {
      bridge.sendAction({ type: "update-draft", text: event.target.value });
      const btn = shell.querySelector('[data-action="send-reply"]');
      if (btn) {
        const hasText = event.target.value.trim().length > 0;
        btn.disabled = !hasText;
        btn.classList.toggle("ready", hasText);
      }
    } else if (event.target.id === "question-custom-input") {
      questionCustomText = event.target.value;
      const btn = shell.querySelector('[data-action="submit-question"]');
      if (btn) btn.disabled = questionCustomText.trim().length === 0;
    }
  });

  // Keyboard shortcuts (Escape, Enter, 1-9 for options, Cmd+Enter for Open in app)
  window.addEventListener("keydown", (event) => {
    const view = resolveEffectiveView();
    if (event.key === "Escape") {
      event.preventDefault();
      closeIsland();
      return;
    }
    if (event.key === "Enter" && event.metaKey && view.kind === "pill" && view.pillKind === "done" && view.done[0]) {
      event.preventDefault();
      bridge.sendAction({
        type: "open-thread",
        environmentId: view.done[0].environmentId,
        threadId: view.done[0].threadId,
      });
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      if (view.kind === "voice" && document.activeElement?.id === "island-draft-input") {
        event.preventDefault();
        submitVoiceReply();
        return;
      }
      if (view.kind === "question") {
        event.preventDefault();
        submitCurrentQuestion();
        return;
      }
    }
    // Number keys 1-9 select approval or question options when not typing in text field
    if (
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      document.activeElement?.tagName !== "INPUT"
    ) {
      const digit = Number.parseInt(event.key, 10);
      if (digit >= 1 && digit <= 9) {
        if (view.kind === "approval") {
          const opt = view.approval.options[digit - 1];
          if (opt) {
            event.preventDefault();
            bridge.sendAction({
              type: "respond-approval",
              environmentId: view.approval.environmentId,
              threadId: view.approval.threadId,
              requestId: view.approval.requestId,
              decision: opt.decision,
            });
            uiMode = "auto";
            showFlash(
              opt.decision === "accept"
                ? "Allowed once"
                : opt.decision === "acceptForSession"
                  ? "Allowed for session"
                  : "Denied",
            );
          }
        } else if (view.kind === "question") {
          const q = view.input.questions[questionIndex] ?? view.input.questions[0];
          const opt = q?.options[digit - 1];
          if (q && opt) {
            event.preventDefault();
            questionCustomText = "";
            if (q.multiSelect) {
              const cur = Array.isArray(questionAnswers[q.id]) ? [...questionAnswers[q.id]] : [];
              const i = cur.indexOf(opt.value);
              if (i >= 0) cur.splice(i, 1);
              else cur.push(opt.value);
              questionAnswers[q.id] = cur;
              render();
            } else {
              questionAnswers[q.id] = opt.value;
              render();
              setTimeout(() => submitCurrentQuestion(), 140);
            }
          }
        }
      }
    }
  });

  // Right-click menu on Island
  shell.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    bridge.showContextMenu();
  });

  // Mouse passthrough toggling so transparent area never intercepts OS clicks
  shell.addEventListener("pointerenter", () => {
    isHovering = true;
    bridge.setMousePassthrough(false);
    const view = resolveEffectiveView();
    if (view.kind === "pill" && (view.pillKind === "approval" || view.pillKind === "input")) {
      if (hoverExpandTimer) clearTimeout(hoverExpandTimer);
      hoverExpandTimer = setTimeout(() => {
        if (!isHovering) return;
        const cur = resolveEffectiveView();
        if (cur.kind === "pill") {
          uiMode = cur.pillKind === "approval" ? "approval" : "question";
          bridge.focusWindow();
          render();
        }
      }, 220);
    }
  });
  shell.addEventListener("pointerleave", () => {
    isHovering = false;
    if (hoverExpandTimer) {
      clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
    }
    const view = resolveEffectiveView();
    if (view.kind === "pill" || view.kind === "hidden") {
      bridge.setMousePassthrough(true);
    }
  });

  // Collapse card when clicking outside the Island window
  window.addEventListener("blur", () => {
    const voiceActive = snapshot?.voice && snapshot.voice.phase !== "idle";
    if (!voiceActive && uiMode !== "auto") {
      uiMode = "auto";
      threadSwitcherOpen = false;
      render();
    }
  });

  bridge.onSnapshot((next) => {
    snapshot = next;
    if (waveCanvasEl) {
      updateWaveVisuals();
    }
    render();
  });

  bridge.onCommand((command) => {
    if (command.type === "close-panel") {
      closeIsland();
      return;
    }
    if (command.type === "open-voice-panel") {
      uiMode = "voice";
      bridge.focusWindow();
      render();
      if (command.startVoice && snapshot?.voice?.available && snapshot?.voice?.phase === "idle") {
        bridge.sendAction({ type: "voice-start" });
      } else {
        setTimeout(() => document.getElementById("island-draft-input")?.focus(), 40);
      }
      return;
    }
    if (command.type === "toggle-voice-panel") {
      const view = resolveEffectiveView();
      if (view.kind === "voice") {
        // Pressing shortcut again while open toggles dictation (matching Dray Island)
        if (snapshot?.voice?.available) {
          bridge.sendAction({ type: "voice-toggle" });
        } else {
          closeIsland();
        }
      } else {
        uiMode = "voice";
        bridge.focusWindow();
        render();
        if (command.startVoice && snapshot?.voice?.available) {
          bridge.sendAction({ type: "voice-start" });
        } else {
          setTimeout(() => document.getElementById("island-draft-input")?.focus(), 40);
        }
      }
    }
  });
})();
</script>
</body>
</html>`;
}
