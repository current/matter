import { SIRI_FLUID_DOTS_FRAG, SIRI_WAVE_FRAG, SIRI_WAVE_VERT } from "./siriWaveShaders.ts";

/**
 * Generates the self-contained HTML/CSS/JS document for the macOS Notch / mattr Island panel.
 * Renders a native concave-ear NotchShape SVG (on notched MacBooks) or floating Dynamic Island
 * capsule (on external / non-notched displays) driven by coupled mass-spring-damper physics,
 * alongside Lilt's 1:1 Siri Wave (GLSL) WebGL shaders.
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
    --island-bg: #000000;
    --island-surface: rgba(255, 255, 255, 0.068);
    --island-surface-hover: rgba(255, 255, 255, 0.115);
    --island-surface-active: rgba(255, 255, 255, 0.17);
    --island-border: rgba(255, 255, 255, 0.09);
    --island-border-strong: rgba(255, 255, 255, 0.19);
    --island-fg: #f5f5f7;
    --island-fg-muted: rgba(245, 245, 247, 0.58);
    --island-fg-subtle: rgba(245, 245, 247, 0.38);
    --island-green: #30d158;
    --island-amber: #fbbf24;
    --island-blue: #60a5fa;
    --island-red: #ff453a;
    --island-btn-primary-bg: #ffffff;
    --island-btn-primary-fg: #000000;
    --island-reveal-ease: cubic-bezier(0.22, 1, 0.36, 1);
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
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Inter", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    user-select: none;
  }

  button,
  .done-item {
    transition: transform 90ms ease, background 130ms ease, color 130ms ease, border-color 130ms ease, opacity 130ms ease;
  }
  button:active:not(:disabled),
  .done-item:active {
    transform: scale(0.96);
  }

  #stage {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    pointer-events: auto;
  }

  #island-svg {
    position: absolute;
    top: 0;
    left: 0;
    pointer-events: none;
    overflow: visible;
    transform-origin: top center;
  }

  #island-content-clip {
    position: absolute;
    top: 0;
    left: 0;
    width: 188px;
    height: 37px;
    overflow: hidden;
    pointer-events: auto;
    transform-origin: top center;
    will-change: transform, opacity;
  }

  #island-content-clip.is-inert {
    pointer-events: none;
  }

  #island-measure {
    position: absolute;
    top: 0;
    left: 50%;
    transform: translateX(-50%);
    width: 188px;
    min-height: 37px;
    color: var(--island-fg);
  }

  @keyframes island-body-enter {
    from {
      opacity: 0;
      filter: blur(5px);
      transform: translateY(-6px) scale(0.965);
    }
    to {
      opacity: 1;
      filter: blur(0px);
      transform: translateY(0) scale(1);
    }
  }

  @keyframes island-wing-enter {
    from {
      opacity: 0;
      filter: blur(3px);
      transform: scale(0.96);
    }
    to {
      opacity: 1;
      filter: blur(0px);
      transform: scale(1);
    }
  }

  .card-body.entering {
    animation: island-body-enter 210ms var(--island-reveal-ease) both;
  }

  .pill-entering {
    animation: island-wing-enter 180ms var(--island-reveal-ease) both;
  }

  @media (prefers-reduced-motion: reduce) {
    @keyframes island-body-enter {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    @keyframes island-wing-enter {
      from { opacity: 0; }
      to { opacity: 1; }
    }
    button:active:not(:disabled),
    .done-item:active {
      transform: none;
    }
  }

  /* Status beacons */
  .status-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    flex: none;
  }
  .status-dot.done {
    background: var(--island-green);
    box-shadow: 0 0 9px rgba(48, 209, 88, 0.72);
  }
  .status-dot.approval {
    background: var(--island-amber);
    box-shadow: 0 0 9px rgba(251, 191, 36, 0.72);
  }
  .status-dot.input {
    background: var(--island-blue);
    box-shadow: 0 0 9px rgba(96, 165, 250, 0.72);
  }
  .status-dot.running {
    background: rgba(245, 245, 247, 0.72);
    box-shadow: 0 0 7px rgba(255, 255, 255, 0.32);
  }
  .status-dot.idle {
    background: rgba(245, 245, 247, 0.56);
    box-shadow: 0 0 8px rgba(255, 255, 255, 0.28);
  }
  .status-dot.error {
    background: var(--island-red);
    box-shadow: 0 0 9px rgba(255, 69, 58, 0.72);
  }

  /* Peek state (hovering physical MacBook notch) */
  .peek-row {
    display: grid;
    align-items: center;
    width: 100%;
    cursor: pointer;
  }
  .peek-wing {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
  }
  .peek-mic {
    color: rgba(245, 245, 247, 0.76);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    transition: color 130ms ease;
  }
  .peek-row:hover .peek-mic {
    color: #ffffff;
  }

  /* Notch-flanking 3-column Live Activity Pill */
  .pill-notched {
    display: grid;
    align-items: center;
    width: 100%;
    cursor: pointer;
  }
  .pill-wing {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .pill-wing.left {
    padding: 0 6px 0 14px;
    justify-content: flex-start;
  }
  .pill-wing.right {
    padding: 0 14px 0 6px;
    justify-content: flex-end;
  }
  .notch-cutout {
    height: 100%;
    pointer-events: none;
  }

  /* Floating non-notched Live Activity Capsule */
  .pill-capsule {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    height: 38px;
    padding: 0 10px 0 14px;
    cursor: pointer;
  }

  .pill-label {
    font-size: 12.5px;
    font-weight: 580;
    letter-spacing: -0.015em;
    color: var(--island-fg);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .pill-label.flash-ok {
    color: var(--island-green);
  }

  .pill-title {
    font-size: 12px;
    color: var(--island-fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    flex: 1;
    text-align: right;
  }
  .pill-capsule .pill-title {
    text-align: left;
  }

  .pill-btn {
    flex: none;
    border: none;
    background: rgba(255, 255, 255, 0.13);
    color: #ffffff;
    font: inherit;
    font-size: 11px;
    font-weight: 560;
    letter-spacing: -0.01em;
    padding: 3.5px 9px;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
  }
  .pill-btn:hover {
    background: rgba(255, 255, 255, 0.22);
  }

  /* 4-bar live reactive equalizer in Voice Mode pill */
  .eq-bars {
    display: inline-flex;
    align-items: center;
    gap: 2.5px;
    height: 14px;
    flex: none;
    padding: 0 2px;
  }
  .eq-bar {
    width: 2.5px;
    height: 4px;
    border-radius: 999px;
    background: var(--island-green);
    transition: height 75ms ease-out, opacity 140ms ease;
  }
  .eq-bars.muted .eq-bar {
    background: var(--island-amber);
    opacity: 0.65;
  }
  .eq-bars.thinking .eq-bar {
    background: var(--island-blue);
  }

  /* Card layout with Notch-Safe Top Wing Header */
  .card-root {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .wing-header {
    display: grid;
    align-items: center;
    width: 100%;
    padding: 0 14px;
    flex: none;
  }
  .wing-header-side {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    height: 100%;
    overflow: hidden;
  }
  .wing-header-side.left {
    padding-right: 4px;
    justify-content: flex-start;
  }
  .wing-header-side.right {
    padding-left: 4px;
    justify-content: flex-end;
    gap: 3px;
  }

  /* Non-notched card header */
  .flat-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 13px 16px 2px;
    min-height: 40px;
    flex: none;
  }

  .card-body {
    padding: 8px 18px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .thread-picker-wrap {
    position: relative;
    min-width: 0;
    flex: 1;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .thread-title-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
    max-width: 100%;
    padding: 3px 5px 3px 0;
    border: none;
    background: transparent;
    color: var(--island-fg);
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.015em;
    cursor: pointer;
    border-radius: 7px;
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
    width: 24px;
    height: 24px;
    border-radius: 999px;
    border: none;
    background: transparent;
    color: var(--island-fg-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    cursor: pointer;
    padding: 0;
    flex: none;
  }
  .wing-header .icon-btn {
    width: 22px;
    height: 22px;
    font-size: 11.5px;
  }
  .icon-btn:hover {
    background: var(--island-surface-hover);
    color: var(--island-fg);
  }

  .badge-chip {
    font-size: 11px;
    font-weight: 560;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--island-surface);
    color: var(--island-fg-muted);
    white-space: nowrap;
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .badge-chip.amber { background: rgba(251, 191, 36, 0.15); color: #fcd34d; }
  .badge-chip.blue { background: rgba(96, 165, 250, 0.15); color: #93c5fd; }
  .badge-chip.green { background: rgba(48, 209, 88, 0.15); color: #6ee7b7; }

  /* Voice Mode Live toggle chip */
  .handsfree-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--island-border);
    background: var(--island-surface);
    color: var(--island-fg-muted);
    font: inherit;
    font-size: 10.5px;
    font-weight: 580;
    letter-spacing: -0.01em;
    padding: 3px 7.5px;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
    flex: none;
  }
  .handsfree-chip:hover {
    color: var(--island-fg);
    background: var(--island-surface-hover);
  }
  .handsfree-chip.live {
    background: rgba(48, 209, 88, 0.16);
    border-color: rgba(48, 209, 88, 0.44);
    color: var(--island-green);
  }

  /* Thread switcher list */
  .thread-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 176px;
    overflow-y: auto;
    padding: 4px;
    border-radius: 13px;
    background: rgba(255, 255, 255, 0.045);
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
    border-radius: 9px;
    cursor: pointer;
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
  .messages-box,
  .assistant-feed {
    display: flex;
    flex-direction: column;
    gap: 7px;
    max-height: 162px;
    overflow-y: auto;
    padding-right: 2px;
  }
  .messages-box::-webkit-scrollbar,
  .assistant-feed::-webkit-scrollbar,
  .thread-list::-webkit-scrollbar,
  .approval-detail::-webkit-scrollbar {
    width: 4px;
  }
  .messages-box::-webkit-scrollbar-thumb,
  .assistant-feed::-webkit-scrollbar-thumb,
  .thread-list::-webkit-scrollbar-thumb,
  .approval-detail::-webkit-scrollbar-thumb {
    background: rgba(255, 255, 255, 0.14);
    border-radius: 999px;
  }

  .user-bubble {
    align-self: flex-end;
    max-width: 88%;
    background: rgba(255, 255, 255, 0.095);
    color: rgba(245, 245, 247, 0.94);
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

  .assistant-reply {
    font-size: 12.5px;
    line-height: 1.46;
    color: var(--island-fg);
    background: var(--island-surface);
    border: 1px solid var(--island-border);
    border-radius: 13px;
    padding: 8px 11px;
    user-select: text;
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
    background: rgba(48, 209, 88, 0.14);
    color: var(--island-green);
  }
  .tool-chip.fail {
    background: rgba(255, 69, 58, 0.14);
    color: var(--island-red);
  }

  .empty-hint {
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--island-fg-subtle);
    padding: 2px 0;
  }

  /* Mode switcher bar */
  .mode-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
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
    font-weight: 550;
    padding: 3.5px 10px;
    border-radius: 999px;
    cursor: pointer;
  }
  .mode-pill-btn:hover {
    color: var(--island-fg);
  }
  .mode-pill-btn.active {
    background: var(--island-btn-primary-bg);
    color: var(--island-btn-primary-fg);
  }

  /* Lilt Siri Wave stage */
  .voice-stage {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 2px 0;
  }

  .transcript-pill {
    position: relative;
    max-width: 100%;
    padding: 5px 12px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.08);
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
    width: 210px;
    height: 84px;
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
    padding: 3px 4px 3px 6px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.055);
    border: 1px solid var(--island-border);
  }
  .composer-row:focus-within {
    border-color: var(--island-border-strong);
    background: rgba(255, 255, 255, 0.075);
  }

  .shortcut-hint {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    border: none;
    background: transparent;
    color: var(--island-fg-subtle);
    font: inherit;
    font-size: 11.5px;
    padding: 4px 7px;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
    flex: none;
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
    padding: 5px 4px;
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
    background: rgba(255, 255, 255, 0.13);
    color: var(--island-fg-muted);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex: none;
  }
  .send-circle-btn.ready {
    background: var(--island-btn-primary-bg);
    color: var(--island-btn-primary-fg);
  }
  .send-circle-btn:hover.ready { transform: scale(1.04); }
  .send-circle-btn:disabled { opacity: 0.42; cursor: default; }

  /* Question & Approval cards */
  .card-submeta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .prompt-heading {
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.015em;
    line-height: 1.36;
    color: var(--island-fg);
    margin: 0;
  }

  .approval-detail {
    font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
    line-height: 1.45;
    color: rgba(245, 245, 247, 0.84);
    background: rgba(255, 255, 255, 0.055);
    border: 1px solid var(--island-border);
    border-radius: 11px;
    padding: 8px 11px;
    max-height: 96px;
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
    border-radius: 13px;
    cursor: pointer;
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
    background: rgba(255, 255, 255, 0.048);
    color: var(--island-fg);
    font: inherit;
    font-size: 13px;
    padding: 9px 12px;
    border-radius: 11px;
    outline: none;
  }
  .custom-answer-input:focus {
    border-color: var(--island-border-strong);
    background: rgba(255, 255, 255, 0.08);
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
    font-size: 12px;
    font-weight: 530;
    padding: 5px 10px;
    border-radius: 999px;
    cursor: pointer;
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
    padding: 8.5px 11px;
    border-radius: 12px;
    background: var(--island-surface);
    cursor: pointer;
  }
  .done-item:hover { background: var(--island-surface-hover); }
</style>
</head>
<body>
<div id="stage">
  <svg id="island-svg" width="560" height="600" viewBox="0 0 560 600" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <linearGradient id="island-rim-grad" x1="0" y1="0" x2="0" y2="1" gradientUnits="objectBoundingBox">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0" />
        <stop offset="35%" stop-color="#ffffff" stop-opacity="0" />
        <stop offset="78%" stop-color="#ffffff" stop-opacity="0.065" />
        <stop offset="100%" stop-color="#ffffff" stop-opacity="0.135" />
      </linearGradient>
      <clipPath id="notch-clip">
        <path id="island-clip-path" d="" />
      </clipPath>
    </defs>
    <g id="island-shape-group">
      <path id="island-shape-path" d="" fill="#000000" />
      <path id="island-rim-path" d="" fill="none" stroke="url(#island-rim-grad)" stroke-width="1" stroke-opacity="0" />
    </g>
  </svg>
  <div id="island-content-clip" class="is-inert">
    <div id="island-measure">
      <div id="island-content"></div>
    </div>
  </div>
</div>
<script>
(() => {
  const SHADERS = ${shadersJson};
  const bridge = window.mattrIsland;
  const stage = document.getElementById("stage");
  const svgEl = document.getElementById("island-svg");
  const shapeGroupEl = document.getElementById("island-shape-group");
  const shapePathEl = document.getElementById("island-shape-path");
  const rimPathEl = document.getElementById("island-rim-path");
  const clipPathEl = document.getElementById("island-clip-path");
  const contentClipEl = document.getElementById("island-content-clip");
  const measureEl = document.getElementById("island-measure");
  const content = document.getElementById("island-content");

  const STAGE_HEIGHT = 600;
  const CARD_WIDTH = 472;
  const NOTCH_PILL_WIDTH = 456;
  const CAPSULE_PILL_WIDTH = 320;
  const CAPSULE_FLASH_WIDTH = 228;
  const CAPSULE_Y = 8;
  let lastStageW = 0;
  let lastStageH = 0;

  let metrics = {
    hasNotch: true,
    notchWidth: 188,
    notchHeight: 37,
    windowWidth: 560,
  };

  let snapshot = null;
  let uiMode = "auto"; // "auto" | "voice" | "approval" | "question" | "done-list"
  let threadSwitcherOpen = false;
  let questionIndex = 0;
  let questionAnswers = {};
  let questionCustomText = "";
  let activeRequestId = null;
  let flashMessage = null;
  let flashTimer = null;

  // Hover & pointer state
  let isPointerInside = false;
  let isNotchPeeking = false;
  let peekEnterTimer = null;
  let peekLeaveTimer = null;
  let hoverExpandTimer = null;
  let lastPassthrough = true;

  // Current geometric mode ("hidden" | "docked" | "peek" | "pill" | "card")
  let geomState = "docked";
  let lastViewKind = "hidden";
  let lastRenderedSignature = "";
  let targetContentWidth = 188;

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Coupled mass-spring-damper physics state
  const springs = {
    w: { pos: 188, vel: 0, target: 188, openK: 375, openD: 24.5, closeK: 440, closeD: 33, eps: 0.08 },
    h: { pos: 37, vel: 0, target: 37, openK: 315, openD: 25.5, closeK: 440, closeD: 33, eps: 0.08 },
    topR: { pos: 6, vel: 0, target: 6, openK: 340, openD: 27, closeK: 440, closeD: 33, eps: 0.08 },
    botR: { pos: 11, vel: 0, target: 11, openK: 340, openD: 27, closeK: 440, closeD: 33, eps: 0.08 },
    expand: { pos: 0, vel: 0, target: 0, openK: 340, openD: 28, closeK: 440, closeD: 33, eps: 0.002 },
    presence: { pos: 1, vel: 0, target: 1, openK: 380, openD: 28, closeK: 440, closeD: 33, eps: 0.002 },
  };
  let springRaf = 0;
  let springLastTime = 0;
  let notifiedIdleForRest = false;

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

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

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

  function setPassthrough(ignore) {
    if (lastPassthrough === ignore) return;
    lastPassthrough = ignore;
    bridge.setMousePassthrough(ignore);
  }

  function notifyIdleIfResting() {
    if (notifiedIdleForRest) return;
    if (geomState === "docked" || geomState === "hidden") {
      notifiedIdleForRest = true;
      destroyWaveGl();
      if (lastRenderedSignature !== "hidden") {
        content.innerHTML = "";
        lastRenderedSignature = "hidden";
      }
      measureEl.style.width = (metrics.hasNotch ? metrics.notchWidth : 220) + "px";
      if (typeof bridge.notifyAnimationIdle === "function") {
        bridge.notifyAnimationIdle();
      }
    }
  }

  // Exact boring.notch concave-ear SVG NotchShape path
  function buildNotchShapePath(cx, w, h, topR, botR, inset) {
    const pad = inset || 0;
    const effW = Math.max(2, w - pad * 2);
    const effH = Math.max(2, h - pad);
    const xL0 = cx - effW / 2 - topR;
    const xL = cx - effW / 2;
    const xR = cx + effW / 2;
    const xR0 = cx + effW / 2 + topR;
    const rB = Math.max(0, Math.min(botR - pad * 0.5, effH / 2, effW / 2));
    const rT = Math.max(0, Math.min(topR, Math.max(0, effH - rB)));
    const y0 = pad ? 0.5 : 0;
    const yEnd = effH;
    const base =
      \`M \${xL0.toFixed(2)},\${y0} \` +
      \`Q \${xL.toFixed(2)},\${y0} \${xL.toFixed(2)},\${(y0 + rT).toFixed(2)} \` +
      \`L \${xL.toFixed(2)},\${(yEnd - rB).toFixed(2)} \` +
      \`Q \${xL.toFixed(2)},\${yEnd.toFixed(2)} \${(xL + rB).toFixed(2)},\${yEnd.toFixed(2)} \` +
      \`L \${(xR - rB).toFixed(2)},\${yEnd.toFixed(2)} \` +
      \`Q \${xR.toFixed(2)},\${yEnd.toFixed(2)} \${xR.toFixed(2)},\${(yEnd - rB).toFixed(2)} \` +
      \`L \${xR.toFixed(2)},\${(y0 + rT).toFixed(2)} \` +
      \`Q \${xR.toFixed(2)},\${y0} \${xR0.toFixed(2)},\${y0}\`;
    return pad ? base : base + " Z";
  }

  function buildCapsulePath(cx, y, w, h, r, inset) {
    const pad = inset || 0;
    const effW = Math.max(2, w - pad * 2);
    const effH = Math.max(2, h - pad * 2);
    const x = cx - effW / 2;
    const yTop = y + pad;
    const cr = Math.max(0, Math.min(r - pad * 0.5, effW / 2, effH / 2));
    return (
      \`M \${(x + cr).toFixed(2)},\${yTop.toFixed(2)} \` +
      \`L \${(x + effW - cr).toFixed(2)},\${yTop.toFixed(2)} \` +
      \`Q \${(x + effW).toFixed(2)},\${yTop.toFixed(2)} \${(x + effW).toFixed(2)},\${(yTop + cr).toFixed(2)} \` +
      \`L \${(x + effW).toFixed(2)},\${(yTop + effH - cr).toFixed(2)} \` +
      \`Q \${(x + effW).toFixed(2)},\${(yTop + effH).toFixed(2)} \${(x + effW - cr).toFixed(2)},\${(yTop + effH).toFixed(2)} \` +
      \`L \${(x + cr).toFixed(2)},\${(yTop + effH).toFixed(2)} \` +
      \`Q \${x.toFixed(2)},\${(yTop + effH).toFixed(2)} \${x.toFixed(2)},\${(yTop + effH - cr).toFixed(2)} \` +
      \`L \${x.toFixed(2)},\${(yTop + cr).toFixed(2)} \` +
      \`Q \${x.toFixed(2)},\${yTop.toFixed(2)} \${(x + cr).toFixed(2)},\${yTop.toFixed(2)} Z\`
    );
  }

  function syncStageSize() {
    const w = Math.round(stage.clientWidth || window.innerWidth || metrics.windowWidth || 560);
    const h = Math.round(stage.clientHeight || window.innerHeight || STAGE_HEIGHT);
    if (w !== lastStageW || h !== lastStageH) {
      lastStageW = w;
      lastStageH = h;
      svgEl.setAttribute("width", String(w));
      svgEl.setAttribute("height", String(h));
      svgEl.setAttribute("viewBox", \`0 0 \${w} \${h}\`);
      svgEl.style.width = w + "px";
      svgEl.style.height = h + "px";
    }
    return { stageW: w, stageH: h };
  }

  function getEffectiveCardWidth() {
    const { stageW } = syncStageSize();
    const margin = metrics.hasNotch ? 36 : 24;
    return Math.min(CARD_WIDTH, Math.max(320, stageW - margin));
  }

  function getEffectiveNotchPillWidth() {
    const { stageW } = syncStageSize();
    return Math.min(NOTCH_PILL_WIDTH, Math.max(metrics.notchWidth + 120, stageW - 28));
  }

  function applyGeometryFrame() {
    const { stageW } = syncStageSize();
    const cx = stageW / 2;
    const w = Math.max(24, springs.w.pos);
    const h = Math.max(24, springs.h.pos);
    const topR = Math.max(0, springs.topR.pos);
    const botR = Math.max(0, springs.botR.pos);
    const e = clamp(springs.expand.pos, 0, 1);
    const p = clamp(springs.presence.pos, 0, 1);

    if (metrics.hasNotch) {
      const d = buildNotchShapePath(cx, w, h, topR, botR, 0);
      const rimD = buildNotchShapePath(cx, w, h, topR, botR, 0.5);
      shapePathEl.setAttribute("d", d);
      clipPathEl.setAttribute("d", d);
      rimPathEl.setAttribute("d", rimD);
      rimPathEl.setAttribute("stroke", "url(#island-rim-grad)");
      rimPathEl.setAttribute("stroke-opacity", e.toFixed(3));

      // Invisible when fully docked inside the hardware notch so it never protrudes on any MacBook size
      const silhouetteAlpha = geomState === "hidden" ? 0 : clamp(e / 0.06, 0, 1);
      svgEl.style.opacity = silhouetteAlpha.toFixed(3);
      svgEl.style.transform = "";

      if (e > 0.01 && geomState !== "hidden") {
        const s1y = (14 * e).toFixed(1);
        const s1b = (32 * e).toFixed(1);
        const s1a = (0.56 * e).toFixed(3);
        const s2y = (3 * e).toFixed(1);
        const s2b = (10 * e).toFixed(1);
        const s2a = (0.34 * e).toFixed(3);
        shapeGroupEl.style.filter = \`drop-shadow(0 \${s1y}px \${s1b}px rgba(0,0,0,\${s1a})) drop-shadow(0 \${s2y}px \${s2b}px rgba(0,0,0,\${s2a}))\`;
      } else {
        shapeGroupEl.style.filter = "none";
      }

      const rB = Math.max(0, Math.min(botR, h / 2, w / 2));
      const xL = cx - w / 2;
      contentClipEl.style.left = xL.toFixed(2) + "px";
      contentClipEl.style.top = "0px";
      contentClipEl.style.width = w.toFixed(2) + "px";
      contentClipEl.style.height = h.toFixed(2) + "px";
      contentClipEl.style.borderRadius = \`0 0 \${rB.toFixed(2)}px \${rB.toFixed(2)}px\`;
      contentClipEl.style.transform = "";
      const contentAlpha =
        geomState === "hidden"
          ? 0
          : geomState === "docked"
            ? clamp((e - 0.1) / 0.4, 0, 1)
            : geomState === "peek"
              ? clamp(e / 0.2, 0, 1)
              : clamp(e / 0.18, 0, 1);
      contentClipEl.style.opacity = contentAlpha.toFixed(3);
      contentClipEl.classList.toggle("is-inert", geomState === "docked" || geomState === "hidden");
    } else {
      const yTop = -4 + (CAPSULE_Y + 4) * p;
      const scale = 0.92 + 0.08 * p;
      const d = buildCapsulePath(cx, yTop, w, h, botR, 0);
      const rimD = buildCapsulePath(cx, yTop, w, h, botR, 0.5);
      shapePathEl.setAttribute("d", d);
      clipPathEl.setAttribute("d", d);
      rimPathEl.setAttribute("d", rimD);
      rimPathEl.setAttribute("stroke", "rgba(255, 255, 255, 0.12)");
      rimPathEl.setAttribute("stroke-opacity", p.toFixed(3));

      svgEl.style.opacity = p.toFixed(3);
      svgEl.style.transform = p < 0.999 ? \`scale(\${scale.toFixed(4)})\` : "";

      if (p > 0.02) {
        const s1y = (12 * p).toFixed(1);
        const s1b = (28 * p).toFixed(1);
        const s1a = (0.52 * p).toFixed(3);
        const s2y = (3 * p).toFixed(1);
        const s2b = (9 * p).toFixed(1);
        const s2a = (0.32 * p).toFixed(3);
        shapeGroupEl.style.filter = \`drop-shadow(0 \${s1y}px \${s1b}px rgba(0,0,0,\${s1a})) drop-shadow(0 \${s2y}px \${s2b}px rgba(0,0,0,\${s2a}))\`;
      } else {
        shapeGroupEl.style.filter = "none";
      }

      const rB = Math.max(0, Math.min(botR, h / 2, w / 2));
      const xL = cx - w / 2;
      contentClipEl.style.left = xL.toFixed(2) + "px";
      contentClipEl.style.top = yTop.toFixed(2) + "px";
      contentClipEl.style.width = w.toFixed(2) + "px";
      contentClipEl.style.height = h.toFixed(2) + "px";
      contentClipEl.style.borderRadius = \`\${rB.toFixed(2)}px\`;
      contentClipEl.style.transform = p < 0.999 ? \`scale(\${scale.toFixed(4)})\` : "";
      contentClipEl.style.opacity = p.toFixed(3);
      contentClipEl.classList.toggle("is-inert", geomState === "hidden" || p < 0.05);
    }
  }

  function stepSpring(s, dt) {
    const opening = s.target >= s.pos;
    const k = opening ? s.openK : s.closeK;
    const d = opening ? s.openD : s.closeD;
    const substeps = dt > 0.016 ? 2 : 1;
    const step = dt / substeps;
    for (let i = 0; i < substeps; i++) {
      const disp = s.pos - s.target;
      const acc = -k * disp - d * s.vel;
      s.vel += acc * step;
      s.pos += s.vel * step;
    }
    if (Math.abs(s.pos - s.target) < s.eps && Math.abs(s.vel) < s.eps) {
      s.pos = s.target;
      s.vel = 0;
      return true;
    }
    return false;
  }

  function tickSprings(now) {
    const dt = springLastTime ? clamp((now - springLastTime) / 1000, 0.001, 0.032) : 1 / 60;
    springLastTime = now;

    let allSettled = true;
    for (const key in springs) {
      if (!stepSpring(springs[key], dt)) {
        allSettled = false;
      }
    }

    applyGeometryFrame();

    if (allSettled) {
      springRaf = 0;
      springLastTime = 0;
      notifyIdleIfResting();
    } else {
      springRaf = requestAnimationFrame(tickSprings);
    }
  }

  function setSpringTargets(targets, immediate) {
    notifiedIdleForRest = false;
    let needsAnim = false;
    for (const key in targets) {
      const s = springs[key];
      if (!s) continue;
      s.target = targets[key];
      if (immediate || prefersReducedMotion) {
        s.pos = s.target;
        s.vel = 0;
      } else if (Math.abs(s.pos - s.target) >= s.eps || Math.abs(s.vel) >= s.eps) {
        needsAnim = true;
      }
    }
    if (immediate || prefersReducedMotion || !needsAnim) {
      if (springRaf) {
        cancelAnimationFrame(springRaf);
        springRaf = 0;
        springLastTime = 0;
      }
      applyGeometryFrame();
      notifyIdleIfResting();
      return;
    }
    if (!springRaf) {
      springLastTime = performance.now();
      springRaf = requestAnimationFrame(tickSprings);
    }
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
      if (metrics.hasNotch && isNotchPeeking) {
        return { kind: "peek" };
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
    if (metrics.hasNotch && isNotchPeeking) {
      return { kind: "peek" };
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

  function updatePillEqualizer() {
    const eq = document.getElementById("pill-eq");
    if (!eq) return;
    const assistant = snapshot?.assistant;
    const voice = snapshot?.voice;
    const muted = Boolean(assistant?.muted);
    const speaking = Boolean(assistant?.speaking || assistant?.phase === "speaking");
    const listening = voice?.phase === "recording" || assistant?.phase === "listening";
    const thinking =
      assistant?.phase === "thinking" ||
      assistant?.phase === "acting" ||
      assistant?.phase === "transcribing";
    const rawLevel = speaking
      ? Math.max(0.22, assistant?.outputLevel ?? 0)
      : listening
        ? Math.max(0.14, voice?.level ?? 0)
        : thinking
          ? 0.35
          : 0.08;
    const lvl = clamp(rawLevel, 0, 1);
    const now = performance.now() / 170;
    const weights = [0.68, 1.0, 0.84, 0.56];
    const bars = eq.querySelectorAll(".eq-bar");
    for (let i = 0; i < bars.length; i++) {
      const wave = muted || (!speaking && !listening && !thinking)
        ? 0.25
        : 0.45 + 0.55 * Math.abs(Math.sin(now + i * 1.15));
      const hPx = muted ? 4 : Math.round(3.5 + 10.5 * lvl * weights[i % weights.length] * wave);
      bars[i].style.height = hPx + "px";
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
          ? 0.55 + 0.9 * clamp(waveLevel, 0, 1)
          : waveState === "idle" || waveState === "error"
            ? 0.45
            : 1;
      waveCanvasEl.style.opacity =
        waveState === "idle" ? "0.62" : waveState === "connecting" ? "0.78" : "1";
      waveCanvasEl.style.transform = "scaleY(" + stretch.toFixed(3) + ")";
      waveCanvasEl.style.filter =
        waveState === "error" ? "sepia(1) saturate(6) hue-rotate(-40deg)" : "";
    }
    updatePillEqualizer();
  }

  function selectedThread() {
    const list = snapshot?.recentThreads ?? [];
    if (list.length === 0) return null;
    return list.find((t) => t.key === snapshot.selectedThreadKey) ?? list[0];
  }

  function renderPeek() {
    const notchW = metrics.notchWidth;
    const h = metrics.notchHeight + 2;
    const approvals = snapshot?.pendingApprovals?.length ?? 0;
    const inputs = snapshot?.pendingUserInputs?.length ?? 0;
    const hasRunning = (snapshot?.recentThreads ?? []).some((t) => t.status === "running" || t.isStreaming);
    const dotClass = approvals > 0 ? "approval" : inputs > 0 ? "input" : hasRunning ? "done" : "idle";
    return \`
      <div class="peek-row pill-entering" style="grid-template-columns:1fr \${notchW}px 1fr;height:\${h}px" data-action="expand-voice" title="Open mattr Island">
        <div class="peek-wing">
          <span class="status-dot \${dotClass}"></span>
        </div>
        <div class="notch-cutout"></div>
        <div class="peek-wing">
          <span class="peek-mic" aria-hidden="true">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <rect x="5.75" y="2" width="4.5" height="7.5" rx="2.25" stroke="currentColor" stroke-width="1.5" />
              <path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25V14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            </svg>
          </span>
        </div>
      </div>
    \`;
  }

  function renderFlash() {
    if (metrics.hasNotch) {
      const notchW = metrics.notchWidth;
      const h = metrics.notchHeight + 2;
      return \`
        <div class="pill-notched pill-entering" style="grid-template-columns:1fr \${notchW}px 1fr;height:\${h}px">
          <div class="pill-wing left">
            <span class="status-dot done"></span>
            <span class="pill-label flash-ok">\${escapeHtml(flashMessage)}</span>
          </div>
          <div class="notch-cutout"></div>
          <div class="pill-wing right">
            <span class="pill-title" style="color:var(--island-green)">✓</span>
          </div>
        </div>
      \`;
    }
    return \`
      <div class="pill-capsule pill-entering" style="justify-content:center">
        <span class="status-dot done"></span>
        <span class="pill-label flash-ok">✓ \${escapeHtml(flashMessage)}</span>
      </div>
    \`;
  }

  function renderPill(view) {
    let dotClass = "done";
    let leftLabel = "mattr";
    let rightTitle = "";
    let ctaLabel = "";
    let ctaAction = "";
    let ctaExtraAttrs = "";
    let rowAction = "expand-voice";
    let showEq = false;
    let eqClass = "";

    if (view.pillKind === "voice-mode") {
      const a = view.assistant || {};
      const speaking = Boolean(a.speaking || a.phase === "speaking");
      const thinking = a.phase === "thinking" || a.phase === "acting" || a.phase === "transcribing";
      const listening = a.phase === "listening" || snapshot?.voice?.phase === "recording";
      dotClass = a.muted ? "approval" : thinking ? "input" : "done";
      leftLabel = a.muted
        ? "Muted"
        : speaking
          ? a.activeBriefingLabel || "Speaking"
          : thinking
            ? a.statusLabel || "Working"
            : listening
              ? "Listening"
              : "Voice Mode";
      ctaLabel = a.handsFreeActive ? "Stop" : "Open";
      ctaAction = a.handsFreeActive ? "assistant-toggle-hands-free" : "expand-voice";
      rowAction = "expand-voice";
      showEq = true;
      eqClass = a.muted ? "muted" : thinking ? "thinking" : "";
    } else if (view.pillKind === "done") {
      const items = view.done;
      dotClass = "done";
      rowAction = "expand-done";
      if (items.length === 1) {
        const item = items[0];
        leftLabel = "Done";
        rightTitle = item.threadTitle;
        ctaLabel = "Open";
        ctaAction = "open-thread";
        ctaExtraAttrs = \`data-env="\${escapeHtml(item.environmentId)}" data-thread="\${escapeHtml(item.threadId)}"\`;
      } else {
        leftLabel = \`\${items.length} done\`;
        ctaLabel = "View";
        ctaAction = "expand-done";
      }
    } else {
      const total = view.count;
      if (total === 1 && view.approvals.length === 1) {
        const item = view.approvals[0];
        dotClass = "approval";
        leftLabel = "Approve";
        rightTitle = item.threadTitle;
        ctaLabel = "Review";
        ctaAction = "expand-approval";
        rowAction = "expand-approval";
      } else if (total === 1 && view.inputs.length === 1) {
        const item = view.inputs[0];
        dotClass = "input";
        leftLabel = "Question";
        rightTitle = item.threadTitle;
        ctaLabel = "Answer";
        ctaAction = "expand-question";
        rowAction = "expand-question";
      } else {
        dotClass = view.approvals.length > 0 ? "approval" : "input";
        leftLabel = \`\${total} pending\`;
        ctaLabel = "Open";
        ctaAction = "expand-attention";
        rowAction = "expand-attention";
      }
    }

    const eqHtml = showEq
      ? \`<span id="pill-eq" class="eq-bars \${eqClass}" aria-hidden="true"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>\`
      : "";
    const ctaHtml = ctaLabel
      ? \`<button class="pill-btn" data-action="\${ctaAction}" \${ctaExtraAttrs}>\${escapeHtml(ctaLabel)}</button>\`
      : "";

    if (metrics.hasNotch) {
      const notchW = metrics.notchWidth;
      const h = metrics.notchHeight + 2;
      return \`
        <div class="pill-notched pill-entering" style="grid-template-columns:1fr \${notchW}px 1fr;height:\${h}px" data-action="\${rowAction}">
          <div class="pill-wing left">
            <span class="status-dot \${dotClass}"></span>
            <span class="pill-label">\${escapeHtml(leftLabel)}</span>
          </div>
          <div class="notch-cutout"></div>
          <div class="pill-wing right">
            \${showEq ? eqHtml : rightTitle ? \`<span class="pill-title">\${escapeHtml(rightTitle)}</span>\` : ""}
            \${ctaHtml}
          </div>
        </div>
      \`;
    }

    return \`
      <div class="pill-capsule pill-entering" data-action="\${rowAction}">
        <span class="status-dot \${dotClass}"></span>
        <span class="pill-label">\${escapeHtml(leftLabel)}</span>
        \${rightTitle ? \`<span class="pill-title">\${escapeHtml(rightTitle)}</span>\` : \`<span style="flex:1"></span>\`}
        \${eqHtml}
        \${ctaHtml}
      </div>
    \`;
  }

  const ICON_EXPAND =
    '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5H13.5V6.5M13.5 2.5L9 7M6.5 13.5H2.5V9.5M2.5 13.5L7 9" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_OPEN_APP =
    '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5H12.5V10M12.5 3.5L4 12" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CLOSE =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';

  function renderCardHeader(leftHtml, rightHtml) {
    if (metrics.hasNotch) {
      const notchW = metrics.notchWidth;
      const h = metrics.notchHeight;
      return \`
        <div class="wing-header" style="grid-template-columns:1fr \${notchW}px 1fr;height:\${h}px">
          <div class="wing-header-side left">\${leftHtml}</div>
          <div class="notch-cutout"></div>
          <div class="wing-header-side right">\${rightHtml}</div>
        </div>
      \`;
    }
    return \`
      <div class="flat-header">
        <div class="thread-picker-wrap">\${leftHtml}</div>
        <div class="header-actions">\${rightHtml}</div>
      </div>
    \`;
  }

  function renderDoneList(entering) {
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
    const headerHtml = renderCardHeader(
      \`<span class="status-dot \${approvals.length > 0 ? "approval" : inputs.length > 0 ? "input" : "done"}"></span><span class="thread-title-text" style="font-size:13px;font-weight:600">Attention</span>\`,
      \`<button class="ghost-btn" style="padding:3px 8px;font-size:11px" data-action="dismiss-done">Clear</button><button class="icon-btn" data-action="close-panel" title="Close (Esc)">\${ICON_CLOSE}</button>\`,
    );
    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body \${entering ? "entering" : ""}">
          <div class="done-list">\${rows.join("")}</div>
        </div>
      </div>
    \`;
  }

  function renderApproval(approval, entering) {
    const opts = approval.options.map((opt, idx) => \`
      <button class="option-card" data-action="pick-approval" data-decision="\${escapeHtml(opt.decision)}">
        <span class="option-num">\${idx + 1}</span>
        <span class="option-body">
          <span class="option-label">\${escapeHtml(opt.label)}</span>
          \${opt.warning ? \`<span class="option-desc">\${escapeHtml(opt.warning)}</span>\` : ""}
        </span>
      </button>
    \`).join("");

    const headerHtml = renderCardHeader(
      \`<span class="status-dot approval"></span><span class="thread-title-text" style="font-size:13px;font-weight:600">Approve</span>\`,
      \`<button class="icon-btn" data-action="open-thread" data-env="\${escapeHtml(approval.environmentId)}" data-thread="\${escapeHtml(approval.threadId)}" title="Open in mattr">\${ICON_OPEN_APP}</button><button class="icon-btn" data-action="close-panel" title="Close (Esc)">\${ICON_CLOSE}</button>\`,
    );

    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body \${entering ? "entering" : ""}">
          <div class="card-submeta">
            <p class="prompt-heading">\${escapeHtml(approval.title)}</p>
            <span class="badge-chip">\${escapeHtml(approval.threadTitle)}</span>
          </div>
          \${approval.detail ? \`<div class="approval-detail">\${escapeHtml(approval.detail)}</div>\` : ""}
          \${approval.reason ? \`<div class="tool-meta">\${escapeHtml(approval.reason)}</div>\` : ""}
          <div class="option-list">\${opts}</div>
        </div>
      </div>
    \`;
  }

  function renderQuestion(input, entering) {
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

    const headerHtml = renderCardHeader(
      \`<span class="status-dot input"></span><span class="thread-title-text" style="font-size:13px;font-weight:600">Question</span>\${input.questions.length > 1 ? \`<span class="badge-chip blue">\${questionIndex + 1}/\${input.questions.length}</span>\` : ""}\`,
      \`<button class="icon-btn" data-action="open-thread" data-env="\${escapeHtml(input.environmentId)}" data-thread="\${escapeHtml(input.threadId)}" title="Open in mattr">\${ICON_OPEN_APP}</button><button class="icon-btn" data-action="close-panel" title="Close (Esc)">\${ICON_CLOSE}</button>\`,
    );

    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body \${entering ? "entering" : ""}">
          <div class="card-submeta">
            <p class="prompt-heading">\${escapeHtml(q.question || q.header)}</p>
            <span class="badge-chip">\${escapeHtml(input.threadTitle)}</span>
          </div>
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
      </div>
    \`;
  }

  function renderVoicePanel(entering) {
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
      assistant.handsFreeActive
        ? assistant.muted
          ? "approval"
          : "done"
        : thread?.status === "approval"
          ? "approval"
          : thread?.status === "input"
            ? "input"
            : thread?.status === "done"
              ? "done"
              : "running";

    const leftWingHtml = \`
      <span class="status-dot \${statusDotClass}"></span>
      <button class="thread-title-btn" data-action="toggle-thread-switcher" title="\${escapeHtml(thread?.title ?? "mattr")}">
        <span class="thread-title-text">\${escapeHtml(isDictationOnly ? (thread?.title ?? "mattr") : "mattr")}</span>
        \${threads.length > 1 ? \`<span class="thread-chevron">▾</span>\` : ""}
      </button>
    \`;

    const rightWingHtml = \`
      <button class="handsfree-chip \${assistant.handsFreeActive ? "live" : ""}" data-action="assistant-toggle-hands-free" title="Hands-free conversational Voice Mode">
        <span class="status-dot \${assistant.handsFreeActive ? "done" : "running"}" style="width:5.5px;height:5.5px"></span>
        <span>\${assistant.handsFreeActive ? "Live" : "Voice"}</span>
      </button>
      <button class="icon-btn" data-action="assistant-open-voice-mode-modal" title="Open full Voice Mode">\${ICON_EXPAND}</button>
      \${thread ? \`<button class="icon-btn" data-action="open-thread" data-env="\${escapeHtml(thread.environmentId)}" data-thread="\${escapeHtml(thread.threadId)}" title="Open in mattr">\${ICON_OPEN_APP}</button>\` : ""}
      <button class="icon-btn" data-action="close-panel" title="Close (Esc)">\${ICON_CLOSE}</button>
    \`;

    const headerHtml = renderCardHeader(leftWingHtml, rightWingHtml);

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
            : "Listening… tap to send"
          : voice.phase === "preparing"
            ? "Starting mic…"
            : voice.phase === "transcribing" ||
                voice.phase === "post-processing" ||
                assistant.phase === "transcribing"
              ? "Transcribing…"
              : shortcutLabel();

    const attentionChipHtml =
      (snapshot?.pendingApprovals?.length ?? 0) > 0
        ? \`<button class="badge-chip amber" style="border:none;cursor:pointer" data-action="expand-approval">Approve</button>\`
        : (snapshot?.pendingUserInputs?.length ?? 0) > 0
          ? \`<button class="badge-chip blue" style="border:none;cursor:pointer" data-action="expand-question">Question</button>\`
          : assistant.handsFreeActive
            ? \`<button class="badge-chip \${assistant.muted ? "amber" : "green"}" style="border:none;cursor:pointer" data-action="assistant-toggle-mute">\${assistant.muted ? "Unmute" : "Mute"}</button>\`
            : "";

    const modeBarHtml = \`
      <div class="mode-bar">
        <div class="mode-pills">
          <button class="mode-pill-btn \${activeMode === "smart" ? "active" : ""}" data-action="assistant-set-mode" data-mode="smart">Smart</button>
          <button class="mode-pill-btn \${activeMode === "assistant" ? "active" : ""}" data-action="assistant-set-mode" data-mode="assistant">Assistant</button>
          <button class="mode-pill-btn \${activeMode === "dictation" ? "active" : ""}" data-action="assistant-set-mode" data-mode="dictation">Dictate</button>
        </div>
        <div class="header-actions">
          \${attentionChipHtml}
        </div>
      </div>
    \`;

    const combinedError = assistant.error || voice.error;

    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body \${entering ? "entering" : ""}">
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
      </div>
    \`;
  }

  function syncCardHeightTarget() {
    if (geomState !== "card") return;
    const { stageH } = syncStageSize();
    const cardW = getEffectiveCardWidth();
    targetContentWidth = cardW;
    measureEl.style.width = cardW + "px";
    const rectH = Math.ceil(measureEl.getBoundingClientRect().height || 0);
    const scrollH = Math.ceil(measureEl.scrollHeight || 0);
    const measured = Math.max(rectH, scrollH, 220) + 4;
    const maxH = Math.max(200, Math.min(540, stageH - 16));
    const clampedH = clamp(measured, 160, maxH);
    setSpringTargets({
      w: cardW,
      h: clampedH,
      topR: metrics.hasNotch ? 16 : 0,
      botR: 26,
      expand: 1,
      presence: 1,
    });
  }

  function syncGeometryForView(view) {
    if (view.kind === "hidden") {
      if (metrics.hasNotch && snapshot?.settings?.enabled !== false) {
        geomState = "docked";
        targetContentWidth = metrics.notchWidth;
        setSpringTargets({
          w: metrics.notchWidth,
          h: metrics.notchHeight,
          topR: 6,
          botR: 11,
          expand: 0,
          presence: 1,
        });
      } else {
        geomState = "hidden";
        targetContentWidth = 220;
        setSpringTargets({
          w: 220,
          h: 34,
          topR: 0,
          botR: 17,
          expand: 0,
          presence: 0,
        });
      }
      return;
    }

    if (view.kind === "peek") {
      geomState = "peek";
      const peekW = metrics.notchWidth + 68;
      targetContentWidth = peekW;
      measureEl.style.width = peekW + "px";
      setSpringTargets({
        w: peekW,
        h: metrics.notchHeight + 2,
        topR: 9,
        botR: 15,
        expand: 0.28,
        presence: 1,
      });
      return;
    }

    if (view.kind === "pill" || view.kind === "flash") {
      geomState = "pill";
      const pillW = metrics.hasNotch
        ? getEffectiveNotchPillWidth()
        : view.kind === "flash"
          ? CAPSULE_FLASH_WIDTH
          : CAPSULE_PILL_WIDTH;
      const pillH = metrics.hasNotch ? metrics.notchHeight + 2 : 38;
      targetContentWidth = pillW;
      measureEl.style.width = pillW + "px";
      setSpringTargets({
        w: pillW,
        h: pillH,
        topR: metrics.hasNotch ? 11 : 0,
        botR: metrics.hasNotch ? 16 : 19,
        expand: 0.52,
        presence: 1,
      });
      return;
    }

    geomState = "card";
    syncCardHeightTarget();
  }

  function render() {
    const view = resolveEffectiveView();
    const enteringCard = view.kind !== lastViewKind && (
      view.kind === "voice" ||
      view.kind === "approval" ||
      view.kind === "question" ||
      view.kind === "done-list"
    );
    lastViewKind = view.kind;

    if (view.kind === "hidden") {
      stopWaveLoop();
      syncGeometryForView(view);
      if (!isPointerInside) {
        setPassthrough(true);
      }
      return;
    }

    if (view.kind === "peek") {
      destroyWaveGl();
      const sig =
        "peek:" +
        metrics.notchWidth +
        ":" +
        metrics.notchHeight +
        ":" +
        (snapshot?.pendingApprovals?.length ?? 0) +
        ":" +
        (snapshot?.pendingUserInputs?.length ?? 0);
      if (sig !== lastRenderedSignature) {
        content.innerHTML = renderPeek();
        lastRenderedSignature = sig;
      }
      syncGeometryForView(view);
      return;
    }

    if (view.kind === "flash") {
      destroyWaveGl();
      const sig = "flash:" + metrics.hasNotch + ":" + flashMessage;
      if (sig !== lastRenderedSignature) {
        content.innerHTML = renderFlash();
        lastRenderedSignature = sig;
      }
      syncGeometryForView(view);
      return;
    }

    if (view.kind === "pill") {
      destroyWaveGl();
      const html = renderPill(view);
      const sig = "pill:" + metrics.hasNotch + ":" + metrics.notchWidth + ":" + html;
      if (sig !== lastRenderedSignature) {
        content.innerHTML = html;
        lastRenderedSignature = sig;
      }
      updatePillEqualizer();
      syncGeometryForView(view);
      return;
    }

    if (view.kind === "done-list") {
      destroyWaveGl();
      const html = renderDoneList(enteringCard);
      const sig = "done-list:" + metrics.hasNotch + ":" + html;
      if (sig !== lastRenderedSignature) {
        content.innerHTML = html;
        lastRenderedSignature = sig;
      }
      syncGeometryForView(view);
      return;
    }

    if (view.kind === "approval") {
      destroyWaveGl();
      const html = renderApproval(view.approval, enteringCard);
      const sig = "approval:" + metrics.hasNotch + ":" + html;
      if (sig !== lastRenderedSignature) {
        content.innerHTML = html;
        lastRenderedSignature = sig;
      }
      syncGeometryForView(view);
      return;
    }

    if (view.kind === "question") {
      destroyWaveGl();
      const html = renderQuestion(view.input, enteringCard);
      const sig = "question:" + metrics.hasNotch + ":" + html;
      if (sig !== lastRenderedSignature) {
        const prevFocused = document.activeElement?.id === "question-custom-input";
        content.innerHTML = html;
        lastRenderedSignature = sig;
        if (prevFocused) document.getElementById("question-custom-input")?.focus();
      }
      syncGeometryForView(view);
      return;
    }

    // Voice panel: avoid clobbering the live WebGL canvas or typing cursor on audio-level ticks
    const prevDraftInput = document.getElementById("island-draft-input");
    const draftFocused = document.activeElement === prevDraftInput;
    const selStart = prevDraftInput?.selectionStart ?? null;
    const selEnd = prevDraftInput?.selectionEnd ?? null;

    const structuralSnapshot = {
      view: "voice",
      hasNotch: metrics.hasNotch,
      notchWidth: metrics.notchWidth,
      notchHeight: metrics.notchHeight,
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
      content.innerHTML = renderVoicePanel(enteringCard);
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
    syncGeometryForView(view);
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
    isNotchPeeking = false;
    uiMode = "auto";
    bridge.sendAction({ type: "voice-cancel" });
    bridge.sendAction({ type: "close-panel" });
    render();
  }

  // Click delegation on active Island content
  contentClipEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    if (action === "open-thread") {
      event.stopPropagation();
      uiMode = "auto";
      isNotchPeeking = false;
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
      isNotchPeeking = false;
      bridge.focusWindow();
      lastPassthrough = false;
      render();
      return;
    }
    if (action === "expand-approval") {
      uiMode = "approval";
      isNotchPeeking = false;
      bridge.focusWindow();
      lastPassthrough = false;
      render();
      return;
    }
    if (action === "expand-question") {
      uiMode = "question";
      isNotchPeeking = false;
      bridge.focusWindow();
      lastPassthrough = false;
      render();
      return;
    }
    if (action === "expand-attention") {
      if ((snapshot?.pendingApprovals?.length ?? 0) > 0) uiMode = "approval";
      else if ((snapshot?.pendingUserInputs?.length ?? 0) > 0) uiMode = "question";
      else uiMode = "done-list";
      isNotchPeeking = false;
      bridge.focusWindow();
      lastPassthrough = false;
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
      isNotchPeeking = false;
      bridge.focusWindow();
      lastPassthrough = false;
      render();
      setTimeout(() => document.getElementById("island-draft-input")?.focus(), 60);
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
    if (action === "assistant-toggle-mute") {
      event.stopPropagation();
      bridge.sendAction({ type: "assistant-toggle-mute" });
      return;
    }
    if (action === "assistant-barge-in") {
      bridge.sendAction({ type: "assistant-barge-in" });
      return;
    }
    if (action === "assistant-open-voice-mode-modal") {
      uiMode = "auto";
      isNotchPeeking = false;
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

  // Clicking transparent margin outside an expanded card dismisses it;
  // clicking directly inside the docked notch immediately opens Voice Assistant
  stage.addEventListener("click", (event) => {
    if (event.target !== stage) return;
    if (geomState === "docked" && metrics.hasNotch && isPointInsideIsland(event.clientX, event.clientY)) {
      isNotchPeeking = false;
      uiMode = "voice";
      bridge.focusWindow();
      lastPassthrough = false;
      render();
      setTimeout(() => document.getElementById("island-draft-input")?.focus(), 60);
      return;
    }
    if (geomState === "card") {
      closeIsland();
    }
  });

  // Live input sync
  contentClipEl.addEventListener("input", (event) => {
    if (event.target.id === "island-draft-input") {
      bridge.sendAction({ type: "update-draft", text: event.target.value });
      const btn = contentClipEl.querySelector('[data-action="send-reply"]');
      if (btn) {
        const hasText = event.target.value.trim().length > 0;
        btn.disabled = !hasText;
        btn.classList.toggle("ready", hasText);
      }
    } else if (event.target.id === "question-custom-input") {
      questionCustomText = event.target.value;
      const btn = contentClipEl.querySelector('[data-action="submit-question"]');
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
                : opt.decision === "acceptAlways"
                  ? "Always allowed"
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
  contentClipEl.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    bridge.showContextMenu();
  });

  // Precise geometric hit-testing for notch hover-to-peek & zero menu-bar interference
  function isPointInsideIsland(x, y) {
    if (!snapshot || !snapshot.settings.enabled) return false;
    const { stageW } = syncStageSize();
    const cx = stageW / 2;

    if (geomState === "hidden") return false;

    if (geomState === "docked") {
      if (!metrics.hasNotch) return false;
      // Strictly confined to the 184 x notchHeight physical camera cutout
      const halfHitW = Math.min(92, metrics.notchWidth / 2);
      return x >= cx - halfHitW && x <= cx + halfHitW && y >= 0 && y <= metrics.notchHeight;
    }

    const liveW = Math.max(springs.w.pos, springs.w.target * 0.85);
    const liveH = Math.max(springs.h.pos, springs.h.target * 0.85);
    const earPad = metrics.hasNotch ? springs.topR.pos * 0.45 : 0;
    const yTop = metrics.hasNotch ? 0 : CAPSULE_Y;
    return (
      x >= cx - liveW / 2 - earPad &&
      x <= cx + liveW / 2 + earPad &&
      y >= yTop &&
      y <= yTop + liveH
    );
  }

  function clearHoverTimers() {
    if (peekEnterTimer) {
      clearTimeout(peekEnterTimer);
      peekEnterTimer = null;
    }
    if (peekLeaveTimer) {
      clearTimeout(peekLeaveTimer);
      peekLeaveTimer = null;
    }
    if (hoverExpandTimer) {
      clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
    }
  }

  function handlePointerOutside() {
    isPointerInside = false;
    if (peekEnterTimer) {
      clearTimeout(peekEnterTimer);
      peekEnterTimer = null;
    }
    if (hoverExpandTimer) {
      clearTimeout(hoverExpandTimer);
      hoverExpandTimer = null;
    }
    if (isNotchPeeking && !peekLeaveTimer) {
      peekLeaveTimer = setTimeout(() => {
        peekLeaveTimer = null;
        if (!isPointerInside && isNotchPeeking) {
          isNotchPeeking = false;
          render();
        }
      }, 110);
    }
    setPassthrough(true);
  }

  window.addEventListener("pointermove", (event) => {
    const inside = isPointInsideIsland(event.clientX, event.clientY);
    if (inside) {
      const wasInside = isPointerInside;
      isPointerInside = true;
      if (peekLeaveTimer) {
        clearTimeout(peekLeaveTimer);
        peekLeaveTimer = null;
      }
      setPassthrough(false);

      if (geomState === "docked" && metrics.hasNotch && !isNotchPeeking && !peekEnterTimer) {
        peekEnterTimer = setTimeout(() => {
          peekEnterTimer = null;
          if (isPointerInside && geomState === "docked" && !isNotchPeeking) {
            isNotchPeeking = true;
            render();
          }
        }, 55);
      } else if (!wasInside) {
        const view = resolveEffectiveView();
        if (view.kind === "pill" && (view.pillKind === "approval" || view.pillKind === "input")) {
          if (hoverExpandTimer) clearTimeout(hoverExpandTimer);
          hoverExpandTimer = setTimeout(() => {
            hoverExpandTimer = null;
            if (!isPointerInside) return;
            const cur = resolveEffectiveView();
            if (cur.kind === "pill") {
              uiMode = cur.pillKind === "approval" ? "approval" : "question";
              bridge.focusWindow();
              lastPassthrough = false;
              render();
            }
          }, 220);
        }
      }
    } else if (isPointerInside || !lastPassthrough) {
      handlePointerOutside();
    }
  });

  document.addEventListener("mouseleave", () => {
    handlePointerOutside();
  });

  // Collapse card when clicking outside the Island window
  window.addEventListener("blur", () => {
    clearHoverTimers();
    isNotchPeeking = false;
    const voiceActive = snapshot?.voice && snapshot.voice.phase !== "idle";
    if (!voiceActive && uiMode !== "auto") {
      uiMode = "auto";
      threadSwitcherOpen = false;
      render();
    }
  });

  // Display metrics from DesktopIsland (notched vs external monitor)
  function applyDisplayMetrics(next) {
    if (!next || typeof next !== "object") return;
    const changedNotch = next.hasNotch !== metrics.hasNotch;
    metrics = {
      hasNotch: Boolean(next.hasNotch),
      notchWidth: Number(next.notchWidth) || 188,
      notchHeight: Number(next.notchHeight) || 37,
      windowWidth: Number(next.windowWidth) || 560,
    };
    syncStageSize();
    if (!metrics.hasNotch) {
      isNotchPeeking = false;
    }
    if (changedNotch && geomState !== "card") {
      setSpringTargets(
        metrics.hasNotch
          ? { w: metrics.notchWidth, h: metrics.notchHeight, topR: 6, botR: 11, expand: 0, presence: 1 }
          : { w: 220, h: 34, topR: 0, botR: 17, expand: 0, presence: 0 },
        true,
      );
    }
    render();
  }

  // Continuously track card height changes (messages, transcripts, switcher, fonts)
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      if (geomState === "card") {
        syncCardHeightTarget();
      }
    });
    ro.observe(measureEl);
  }

  window.addEventListener("resize", () => {
    syncStageSize();
    if (geomState === "card") {
      syncCardHeightTarget();
    } else if (geomState === "pill" && metrics.hasNotch) {
      const pillW = getEffectiveNotchPillWidth();
      targetContentWidth = pillW;
      measureEl.style.width = pillW + "px";
      setSpringTargets({ w: pillW }, true);
    }
    applyGeometryFrame();
  });

  if (typeof bridge.onDisplayMetrics === "function") {
    bridge.onDisplayMetrics((next) => applyDisplayMetrics(next));
  }

  bridge.onSnapshot((next) => {
    snapshot = next;
    updateWaveVisuals();
    render();
  });

  bridge.onCommand((command) => {
    if (command.type === "close-panel") {
      closeIsland();
      return;
    }
    if (command.type === "open-voice-panel") {
      isNotchPeeking = false;
      uiMode = "voice";
      bridge.focusWindow();
      lastPassthrough = false;
      render();
      if (command.startVoice && snapshot?.voice?.available && snapshot?.voice?.phase === "idle") {
        bridge.sendAction({ type: "voice-start" });
      } else {
        setTimeout(() => document.getElementById("island-draft-input")?.focus(), 50);
      }
      return;
    }
    if (command.type === "toggle-voice-panel") {
      const view = resolveEffectiveView();
      if (view.kind === "voice") {
        if (snapshot?.voice?.available) {
          bridge.sendAction({ type: "voice-toggle" });
        } else {
          closeIsland();
        }
      } else {
        isNotchPeeking = false;
        uiMode = "voice";
        bridge.focusWindow();
        lastPassthrough = false;
        render();
        if (command.startVoice && snapshot?.voice?.available) {
          bridge.sendAction({ type: "voice-start" });
        } else {
          setTimeout(() => document.getElementById("island-draft-input")?.focus(), 50);
        }
      }
    }
  });

  // Paint initial resting frame (docked invisibly inside hardware notch)
  applyGeometryFrame();
})();
</script>
</body>
</html>`;
}
