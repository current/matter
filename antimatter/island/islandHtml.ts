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
    --island-emerald: #34d399;
    --island-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
    --island-ease-in: cubic-bezier(0.4, 0, 1, 1);
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
    width: 200px;
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
    width: 200px;
    min-height: 37px;
    color: var(--island-fg);
  }

  /* Press feedback: snaps in fast, releases on a softer ease. */
  button,
  .done-item {
    transition: transform 160ms var(--island-ease-out), background 130ms ease, color 130ms ease, border-color 130ms ease, opacity 130ms ease;
  }
  button:active:not(:disabled),
  .done-item:active {
    transform: scale(0.95);
    transition-duration: 70ms;
  }

  /* Blur-scale content morph, anchored to the notch edge (transform-origin 50% 0%). */
  #island-content > *,
  .morph-layer > * {
    transform-origin: 50% 0%;
  }
  .morph-layer {
    position: absolute;
    top: 0;
    left: 50%;
    pointer-events: none;
    transform-origin: 50% 0%;
  }
  @keyframes island-morph-in {
    from { opacity: 0; filter: blur(10px); transform: scale(0.94) translateY(-6px); }
    to { opacity: 1; filter: blur(0px); transform: none; }
  }
  @keyframes island-morph-out {
    from { opacity: 1; filter: blur(0px); transform: none; }
    to { opacity: 0; filter: blur(8px); transform: scale(0.93) translateY(-4px); }
  }
  @keyframes island-slide-in-next {
    from { opacity: 0; filter: blur(6px); transform: translateX(22px); }
    to { opacity: 1; filter: blur(0px); transform: none; }
  }
  @keyframes island-slide-in-prev {
    from { opacity: 0; filter: blur(6px); transform: translateX(-22px); }
    to { opacity: 1; filter: blur(0px); transform: none; }
  }
  @keyframes island-slide-out-next {
    from { opacity: 1; filter: blur(0px); transform: none; }
    to { opacity: 0; filter: blur(6px); transform: translateX(-22px); }
  }
  @keyframes island-slide-out-prev {
    from { opacity: 1; filter: blur(0px); transform: none; }
    to { opacity: 0; filter: blur(6px); transform: translateX(22px); }
  }
  .morph-in { animation: island-morph-in 260ms var(--island-ease-out) both; }
  .morph-out { animation: island-morph-out 110ms var(--island-ease-in) both; }
  .slide-in-next { animation: island-slide-in-next 260ms var(--island-ease-out) both; }
  .slide-in-prev { animation: island-slide-in-prev 260ms var(--island-ease-out) both; }
  .slide-out-next { animation: island-slide-out-next 130ms var(--island-ease-in) both; }
  .slide-out-prev { animation: island-slide-out-prev 130ms var(--island-ease-in) both; }

  /* One-shot pings: tied to real activity changes, never looping. */
  @keyframes island-ping {
    0% { transform: scale(1); }
    35% { transform: scale(1.6); }
    100% { transform: scale(1); }
  }
  @keyframes island-check-draw {
    from { stroke-dashoffset: 14; }
    to { stroke-dashoffset: 0; }
  }
  .provider-dot.ping,
  .live-dot.ping {
    animation: island-ping 620ms var(--island-ease-out) 1;
  }
  .plan-row.tick .plan-check path {
    stroke-dasharray: 14;
    animation: island-check-draw 420ms var(--island-ease-out) 1 both;
  }

  #island-rim-path {
    transition: stroke 260ms ease;
  }

  @media (prefers-reduced-motion: reduce) {
    @keyframes island-morph-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes island-morph-out { from { opacity: 1; } to { opacity: 0; } }
    @keyframes island-slide-in-next { from { opacity: 0; } to { opacity: 1; } }
    @keyframes island-slide-in-prev { from { opacity: 0; } to { opacity: 1; } }
    @keyframes island-slide-out-next { from { opacity: 1; } to { opacity: 0; } }
    @keyframes island-slide-out-prev { from { opacity: 1; } to { opacity: 0; } }
    .provider-dot.ping,
    .live-dot.ping,
    .plan-row.tick .plan-check path {
      animation: none;
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
    text-align: right;
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
    width: 21px;
    height: 21px;
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
  .wing-header .handsfree-chip {
    padding: 2.5px 6px;
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
    min-height: 22px;
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

  .card-heading {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: -0.015em;
  }
  .ghost-btn.compact {
    padding: 3px 8px;
    font-size: 11px;
  }
  .icon-btn.small {
    width: 20px;
    height: 20px;
  }
  .badge-chip.emerald { background: rgba(52, 211, 153, 0.15); color: #6ee7b7; }
  .badge-chip.live { background: rgba(48, 209, 88, 0.14); color: #86efac; }
  .badge-chip.red { background: rgba(255, 69, 58, 0.15); color: #fca5a5; }
  .pill-btn.emerald { background: rgba(52, 211, 153, 0.2); color: #a7f3d0; }
  .pill-btn.emerald:hover { background: rgba(52, 211, 153, 0.3); }
  .pill-label.done-label { color: #a7f3d0; }

  .done-tick {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--island-emerald);
    flex: none;
  }

  .provider-dot {
    width: 7px;
    height: 7px;
    border-radius: 999px;
    flex: none;
    display: inline-block;
  }
  .provider-stack {
    display: inline-flex;
    align-items: center;
    flex: none;
  }
  .provider-stack .provider-dot + .provider-dot {
    margin-left: -2.5px;
    box-shadow: 0 0 0 1.5px #000000;
  }
  .live-dot {
    width: 6px;
    height: 6px;
    border-radius: 999px;
    flex: none;
    background: var(--island-green);
    box-shadow: 0 0 8px rgba(48, 209, 88, 0.6);
  }

  .elapsed,
  .carousel-count,
  .plan-count {
    font-variant-numeric: tabular-nums;
    font-feature-settings: "tnum";
  }
  .pill-timer {
    font-size: 12px;
    font-weight: 560;
    color: var(--island-fg-muted);
    white-space: nowrap;
  }

  .carousel-nav {
    display: inline-flex;
    align-items: center;
    gap: 2px;
    flex: none;
    font-size: 11px;
    font-weight: 560;
    color: var(--island-fg-muted);
  }
  .carousel-count {
    min-width: 34px;
    text-align: center;
  }

  .agent-title {
    display: block;
    width: 100%;
    border: none;
    background: transparent;
    padding: 0;
    color: var(--island-fg);
    font: inherit;
    font-size: 15px;
    font-weight: 620;
    letter-spacing: -0.02em;
    line-height: 1.3;
    text-align: left;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .agent-title:hover { color: #ffffff; }

  .meta-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 5px;
    margin-top: -4px;
  }
  .meta-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 180px;
    font-size: 11px;
    font-weight: 540;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--island-surface);
    color: var(--island-fg-muted);
    white-space: nowrap;
  }
  .meta-chip.mono {
    font-family: "SF Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10.5px;
  }
  .meta-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .activity-now {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 11px;
    border-radius: 12px;
    background: var(--island-surface);
    font-size: 12.5px;
    color: var(--island-fg);
  }
  .activity-now.muted { color: var(--island-fg-muted); }
  .activity-label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .activity-icon {
    flex: none;
    color: var(--island-fg-muted);
  }
  .activity-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 0 11px;
    margin-top: -3px;
  }
  .activity-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--island-fg-subtle);
  }
  .activity-row .activity-icon { color: var(--island-fg-subtle); }

  .plan-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    color: var(--island-fg-muted);
  }
  .plan-check {
    display: inline-flex;
    color: var(--island-emerald);
    flex: none;
  }
  .plan-bar {
    flex: 0 0 72px;
    height: 3px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
  }
  .plan-bar-fill {
    display: block;
    width: 100%;
    height: 100%;
    background: var(--island-emerald);
    transform-origin: left center;
  }
  .plan-step {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--island-fg-subtle);
  }

  .clamp-3 {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .agent-strip {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
  }
  .agent-strip::-webkit-scrollbar { display: none; }
  .agent-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 150px;
    flex: none;
    border: 1px solid transparent;
    background: var(--island-surface);
    color: var(--island-fg-muted);
    font: inherit;
    font-size: 11px;
    font-weight: 540;
    padding: 3px 9px 3px 7px;
    border-radius: 999px;
    cursor: pointer;
    white-space: nowrap;
  }
  .agent-chip:hover { background: var(--island-surface-hover); color: var(--island-fg); }
  .agent-chip.active {
    background: var(--island-surface-active);
    border-color: var(--island-border-strong);
    color: var(--island-fg);
  }
  .agent-chip-title {
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
</head>
<body>
<div id="stage">
  <svg id="island-svg" width="560" height="600" viewBox="0 0 560 600" preserveAspectRatio="none" aria-hidden="true">
    <defs>
      <clipPath id="notch-clip">
        <path id="island-clip-path" d="" />
      </clipPath>
    </defs>
    <g id="island-shape-group">
      <path id="island-shape-path" d="" fill="#000000" />
      <path id="island-rim-path" d="" fill="none" stroke-width="0.5" stroke-opacity="0" style="stroke: rgba(255, 255, 255, 0.08)" />
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
  const NOTCH_PILL_WIDTH = 468;
  const CAPSULE_PILL_WIDTH = 320;
  const CAPSULE_FLASH_WIDTH = 228;
  const CAPSULE_RUNNING_WIDTH = 236;
  const CAPSULE_Y = 8;
  let lastStageW = 0;
  let lastStageH = 0;

  let metrics = {
    hasNotch: true,
    notchWidth: 200,
    notchHeight: 37,
    windowWidth: 560,
  };

  let snapshot = null;
  // "auto" | "voice" | "attention" | "agents" | "done-list"
  let uiMode = "auto";
  let threadSwitcherOpen = false;
  let questionIndex = 0;
  let questionAnswers = {};
  let questionCustomText = "";
  let activeRequestId = null;
  let flashMessage = null;
  let flashTimer = null;

  // Attention carousel & multi-agent switcher
  let attentionKey = null;
  let attentionIndex = 0;
  let attentionAutoOpened = false;
  let autoCollapseTimer = null;
  const answeredRequestIds = new Set();
  const seenAttentionIds = new Set();
  let agentKey = null;
  let navDirection = "fade";

  // Hover & pointer state
  let isPointerInside = false;
  let isHoverNudge = false;
  let isNotchPeeking = false;
  let peekEnterTimer = null;
  let peekLeaveTimer = null;
  let hoverExpandTimer = null;
  let lastPassthrough = true;

  // Geometric mode: "hidden" | "docked" | "nudge" | "peek" | "pill" | "card"
  let geomState = "docked";
  let lastGeomHover = 0;
  let lastRenderedSignature = "";
  let lastMorphKey = "";
  let morphStartedAt = -Infinity;
  let morphDirection = "fade";
  let currentRimTone = "";
  let elapsedTimer = null;
  let lastPingSignature = "";
  let lastPlanSignature = "";

  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const PEEK_WING = 44;
  const PILL_WING = { running: 112, done: 134, attention: 134, "voice-mode": 134 };
  const GEOM_RANK = { hidden: 0, docked: 0, nudge: 1, peek: 2, pill: 3, card: 4 };
  // WWDC23-style springs per animated value: [response (s), dampingRatio, start delay (ms)].
  // Opening: width leads and height follows ~25ms later with a little jelly overshoot.
  // Closing: height pulls in first and everything settles near-critically so it snaps home.
  const MOTION = {
    open: {
      w: [0.34, 0.78, 0],
      h: [0.4, 0.74, 25],
      earR: [0.36, 0.8, 0],
      botR: [0.38, 0.78, 12],
      expand: [0.3, 0.9, 0],
      presence: [0.32, 0.86, 0],
    },
    close: {
      w: [0.28, 0.88, 18],
      h: [0.28, 0.88, 0],
      earR: [0.26, 0.9, 0],
      botR: [0.28, 0.88, 0],
      expand: [0.24, 0.95, 0],
      presence: [0.26, 0.92, 0],
    },
    peek: {
      w: [0.26, 0.76, 0],
      h: [0.26, 0.76, 0],
      earR: [0.26, 0.8, 0],
      botR: [0.26, 0.8, 0],
      expand: [0.22, 0.9, 0],
      presence: [0.26, 0.86, 0],
    },
  };
  const MORPH_ENTER_DELAY_MS = 65;
  const SLIDE_ENTER_DELAY_MS = 30;
  const MORPH_ENTER_DURATION_MS = 260;
  const RIM_TONES = {
    normal: { stroke: "rgba(255, 255, 255, 0.08)", glow: "" },
    attention: {
      stroke: "rgba(251, 146, 60, 0.42)",
      glow: "drop-shadow(0 0 3px rgba(251, 146, 60, 0.35))",
    },
    done: {
      stroke: "rgba(52, 211, 153, 0.34)",
      glow: "drop-shadow(0 0 3px rgba(52, 211, 153, 0.28))",
    },
  };

  function configureSpring(s, response, dampingRatio) {
    const omega = (2 * Math.PI) / response;
    s.k = omega * omega;
    s.c = 2 * dampingRatio * omega;
  }

  function makeSpring(pos, eps) {
    const s = { pos, vel: 0, target: pos, pending: null, releaseAt: 0, k: 0, c: 0, eps };
    configureSpring(s, 0.28, 0.88);
    return s;
  }

  // Independent velocity-preserving springs: retargeting keeps (pos, vel), so every state
  // change (hover, click, new request, voice) interrupts mid-flight with zero jump.
  const springs = {
    w: makeSpring(200, 0.05),
    h: makeSpring(37, 0.05),
    earR: makeSpring(6, 0.02),
    botR: makeSpring(11, 0.02),
    expand: makeSpring(0, 0.002),
    presence: makeSpring(1, 0.002),
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
      clearOutgoingLayers();
      if (lastRenderedSignature !== "hidden") {
        content.innerHTML = "";
        lastRenderedSignature = "hidden";
        lastMorphKey = "";
      }
      syncElapsedTicker();
      measureEl.style.width = (metrics.hasNotch ? metrics.notchWidth : 220) + "px";
      if (typeof bridge.notifyAnimationIdle === "function") {
        bridge.notifyAnimationIdle();
      }
    }
  }

  const KAPPA = 0.5523;

  function fmt(n) {
    return n.toFixed(2);
  }

  // Concave-ear NotchShape: circular (cubic, kappa) ears flare into y = 0 and the bottom
  // corners are true quarter circles, so the silhouette reads as hardware, not a rounded rect.
  function buildNotchShapePath(cx, w, h, earR, botR, inset) {
    const pad = inset || 0;
    const effW = Math.max(2, w - pad * 2);
    const effH = Math.max(2, h - pad);
    const xL = cx - effW / 2;
    const xR = cx + effW / 2;
    const rB = Math.max(0, Math.min(botR - pad * 0.5, effH / 2, effW / 2));
    const rT = Math.max(0, Math.min(earR, Math.max(0, effH - rB)));
    const xL0 = xL - rT;
    const xR0 = xR + rT;
    const y0 = pad ? 0.5 : 0;
    const yB = effH;
    const kT = rT * KAPPA;
    const kB = rB * KAPPA;
    const base =
      "M " + fmt(xL0) + "," + fmt(y0) +
      " C " + fmt(xL0 + kT) + "," + fmt(y0) + " " + fmt(xL) + "," + fmt(y0 + rT - kT) + " " + fmt(xL) + "," + fmt(y0 + rT) +
      " L " + fmt(xL) + "," + fmt(yB - rB) +
      " C " + fmt(xL) + "," + fmt(yB - rB + kB) + " " + fmt(xL + rB - kB) + "," + fmt(yB) + " " + fmt(xL + rB) + "," + fmt(yB) +
      " L " + fmt(xR - rB) + "," + fmt(yB) +
      " C " + fmt(xR - rB + kB) + "," + fmt(yB) + " " + fmt(xR) + "," + fmt(yB - rB + kB) + " " + fmt(xR) + "," + fmt(yB - rB) +
      " L " + fmt(xR) + "," + fmt(y0 + rT) +
      " C " + fmt(xR) + "," + fmt(y0 + rT - kT) + " " + fmt(xR0 - kT) + "," + fmt(y0) + " " + fmt(xR0) + "," + fmt(y0);
    return pad ? base : base + " Z";
  }

  function buildCapsulePath(cx, y, w, h, r, inset) {
    const pad = inset || 0;
    const effW = Math.max(2, w - pad * 2);
    const effH = Math.max(2, h - pad * 2);
    const x = cx - effW / 2;
    const xR = x + effW;
    const yT = y + pad;
    const yB = yT + effH;
    const cr = Math.max(0, Math.min(r - pad * 0.5, effW / 2, effH / 2));
    const k = cr * KAPPA;
    return (
      "M " + fmt(x + cr) + "," + fmt(yT) +
      " L " + fmt(xR - cr) + "," + fmt(yT) +
      " C " + fmt(xR - cr + k) + "," + fmt(yT) + " " + fmt(xR) + "," + fmt(yT + cr - k) + " " + fmt(xR) + "," + fmt(yT + cr) +
      " L " + fmt(xR) + "," + fmt(yB - cr) +
      " C " + fmt(xR) + "," + fmt(yB - cr + k) + " " + fmt(xR - cr + k) + "," + fmt(yB) + " " + fmt(xR - cr) + "," + fmt(yB) +
      " L " + fmt(x + cr) + "," + fmt(yB) +
      " C " + fmt(x + cr - k) + "," + fmt(yB) + " " + fmt(x) + "," + fmt(yB - cr + k) + " " + fmt(x) + "," + fmt(yB - cr) +
      " L " + fmt(x) + "," + fmt(yT + cr) +
      " C " + fmt(x) + "," + fmt(yT + cr - k) + " " + fmt(x + cr - k) + "," + fmt(yT) + " " + fmt(x + cr) + "," + fmt(yT) +
      " Z"
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
      svgEl.setAttribute("viewBox", "0 0 " + w + " " + h);
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

  function shadowFilter(amount, y1, b1, a1, y2, b2, a2) {
    return (
      "drop-shadow(0 " + (y1 * amount).toFixed(1) + "px " + (b1 * amount).toFixed(1) + "px rgba(0,0,0," + (a1 * amount).toFixed(3) + ")) " +
      "drop-shadow(0 " + (y2 * amount).toFixed(1) + "px " + (b2 * amount).toFixed(1) + "px rgba(0,0,0," + (a2 * amount).toFixed(3) + "))"
    );
  }

  function applyGeometryFrame() {
    const { stageW } = syncStageSize();
    const cx = stageW / 2;
    const w = Math.max(24, springs.w.pos);
    const h = Math.max(24, springs.h.pos);
    const earR = Math.max(0, springs.earR.pos);
    const botR = Math.max(0, springs.botR.pos);
    const e = clamp(springs.expand.pos, 0, 1);
    const p = clamp(springs.presence.pos, 0, 1);

    if (metrics.hasNotch) {
      const d = buildNotchShapePath(cx, w, h, earR, botR, 0);
      shapePathEl.setAttribute("d", d);
      clipPathEl.setAttribute("d", d);
      rimPathEl.setAttribute("d", buildNotchShapePath(cx, w, h, earR, botR, 0.5));
      rimPathEl.setAttribute("stroke-opacity", clamp(e / 0.3, 0, 1).toFixed(3));

      // Invisible while docked inside the hardware notch so it never protrudes on any MacBook.
      const silhouetteAlpha = geomState === "hidden" ? 0 : clamp(e / 0.06, 0, 1);
      svgEl.style.opacity = silhouetteAlpha.toFixed(3);
      svgEl.style.transform = "";
      shapeGroupEl.style.filter =
        e > 0.01 && geomState !== "hidden" ? shadowFilter(e, 14, 32, 0.56, 3, 10, 0.34) : "none";

      const rB = Math.max(0, Math.min(botR, h / 2, w / 2));
      contentClipEl.style.left = fmt(cx - w / 2) + "px";
      contentClipEl.style.top = "0px";
      contentClipEl.style.width = fmt(w) + "px";
      contentClipEl.style.height = fmt(h) + "px";
      contentClipEl.style.borderRadius = "0 0 " + fmt(rB) + "px " + fmt(rB) + "px";
      contentClipEl.style.transform = "";
      const contentAlpha =
        geomState === "hidden"
          ? 0
          : geomState === "docked" || geomState === "nudge"
            ? clamp(e / 0.22, 0, 1)
            : 1;
      contentClipEl.style.opacity = contentAlpha.toFixed(3);
      contentClipEl.classList.toggle(
        "is-inert",
        geomState === "docked" || geomState === "hidden" || geomState === "nudge",
      );
    } else {
      const yTop = -4 + (CAPSULE_Y + 4) * p;
      const scale = 0.92 + 0.08 * p;
      const d = buildCapsulePath(cx, yTop, w, h, botR, 0);
      shapePathEl.setAttribute("d", d);
      clipPathEl.setAttribute("d", d);
      rimPathEl.setAttribute("d", buildCapsulePath(cx, yTop, w, h, botR, 0.5));
      rimPathEl.setAttribute("stroke-opacity", p.toFixed(3));

      svgEl.style.opacity = p.toFixed(3);
      svgEl.style.transform = p < 0.999 ? "scale(" + scale.toFixed(4) + ")" : "";
      shapeGroupEl.style.filter = p > 0.02 ? shadowFilter(p, 12, 28, 0.52, 3, 9, 0.32) : "none";

      const rB = Math.max(0, Math.min(botR, h / 2, w / 2));
      contentClipEl.style.left = fmt(cx - w / 2) + "px";
      contentClipEl.style.top = fmt(yTop) + "px";
      contentClipEl.style.width = fmt(w) + "px";
      contentClipEl.style.height = fmt(h) + "px";
      contentClipEl.style.borderRadius = fmt(rB) + "px";
      contentClipEl.style.transform = p < 0.999 ? "scale(" + scale.toFixed(4) + ")" : "";
      contentClipEl.style.opacity = p.toFixed(3);
      contentClipEl.classList.toggle("is-inert", geomState === "hidden" || p < 0.05);
    }
  }

  // Semi-implicit Euler at <= 1/240s substeps: stable for the stiffest (0.26s) spring.
  function stepSpring(s, dt, now) {
    if (s.pending !== null && now >= s.releaseAt) {
      s.target = s.pending;
      s.pending = null;
    }
    const steps = Math.max(1, Math.ceil(dt * 240));
    const step = dt / steps;
    for (let i = 0; i < steps; i++) {
      const acc = -s.k * (s.pos - s.target) - s.c * s.vel;
      s.vel += acc * step;
      s.pos += s.vel * step;
    }
    if (s.pending === null && Math.abs(s.pos - s.target) < s.eps && Math.abs(s.vel) < s.eps * 10) {
      s.pos = s.target;
      s.vel = 0;
      return true;
    }
    return false;
  }

  function tickSprings(now) {
    const dt = springLastTime ? clamp((now - springLastTime) / 1000, 0.001, 0.034) : 1 / 60;
    springLastTime = now;

    let allSettled = true;
    for (const key in springs) {
      if (!stepSpring(springs[key], dt, now)) {
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

  // profile: "open" | "close" | "peek" | "auto" (auto picks open/close per value by direction).
  function setSpringTargets(targets, options) {
    const immediate = Boolean(options && options.immediate) || prefersReducedMotion;
    const profile = (options && options.profile) || "auto";
    notifiedIdleForRest = false;
    const now = performance.now();
    let needsAnim = false;
    for (const key in targets) {
      const s = springs[key];
      if (!s) continue;
      const value = targets[key];
      if (immediate) {
        s.pos = value;
        s.vel = 0;
        s.target = value;
        s.pending = null;
        continue;
      }
      const current = s.pending !== null ? s.pending : s.target;
      if (Math.abs(value - current) < 1e-6) {
        if (s.pending !== null || Math.abs(s.pos - s.target) >= s.eps || Math.abs(s.vel) >= s.eps) {
          needsAnim = true;
        }
        continue;
      }
      const resolved = profile === "auto" ? (value >= current ? "open" : "close") : profile;
      const [response, dampingRatio, delayMs] = MOTION[resolved][key];
      configureSpring(s, response, dampingRatio);
      // Stagger only from rest; mid-flight retargets must respond on the very next frame.
      if (delayMs > 0 && s.pending === null && Math.abs(s.vel) < 1) {
        s.pending = value;
        s.releaseAt = now + delayMs;
      } else {
        s.target = value;
        s.pending = null;
      }
      needsAnim = true;
    }
    if (immediate || !needsAnim) {
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

  function isActiveStatus(status) {
    return status === "running" || status === "approval" || status === "input";
  }

  function activeAgents() {
    return (snapshot?.recentThreads ?? []).filter((t) => isActiveStatus(t.status));
  }

  function agentList() {
    const agents = activeAgents();
    return agents.length > 0 ? agents : (snapshot?.recentThreads ?? []).slice(0, 1);
  }

  // Approvals first, then questions; answered ones vanish immediately, before the next snapshot.
  function attentionItems() {
    const items = [];
    for (const approval of snapshot?.pendingApprovals ?? []) {
      if (!answeredRequestIds.has(approval.requestId)) {
        items.push({ kind: "approval", requestId: approval.requestId, item: approval });
      }
    }
    for (const input of snapshot?.pendingUserInputs ?? []) {
      if (!answeredRequestIds.has(input.requestId)) {
        items.push({ kind: "question", requestId: input.requestId, item: input });
      }
    }
    return items;
  }

  function currentAttention(items) {
    if (items.length === 0) return null;
    let index = items.findIndex((entry) => entry.requestId === attentionKey);
    if (index < 0) index = clamp(attentionIndex, 0, items.length - 1);
    attentionIndex = index;
    attentionKey = items[index].requestId;
    return { index, total: items.length, entry: items[index] };
  }

  function currentAttentionEntry() {
    const cur = currentAttention(attentionItems());
    return cur ? cur.entry : null;
  }

  function hoverView() {
    if (metrics.hasNotch && isNotchPeeking) return { kind: "peek" };
    if (metrics.hasNotch && isHoverNudge && isPointerInside) return { kind: "nudge" };
    return { kind: "hidden" };
  }

  function resolveEffectiveView() {
    if (flashMessage) return { kind: "flash" };
    if (!snapshot || !snapshot.settings.enabled) return { kind: "hidden" };

    const items = attentionItems();
    const done = snapshot.doneNotifications || [];
    const agents = activeAgents();
    const voiceActive = snapshot.voice && snapshot.voice.phase !== "idle";
    const assistant = snapshot.assistant;
    const assistantActive =
      assistant &&
      (assistant.phase === "listening" ||
        assistant.phase === "transcribing" ||
        assistant.phase === "thinking" ||
        assistant.phase === "acting" ||
        assistant.phase === "speaking");

    if (uiMode === "voice" || voiceActive) return { kind: "voice" };
    if (uiMode === "attention" && items.length > 0) {
      return { kind: "attention", ...currentAttention(items) };
    }
    if (uiMode === "agents" && agentList().length > 0) return { kind: "agents" };
    if (uiMode === "done-list" && done.length > 0) return { kind: "done-list" };

    if (assistant?.handsFreeActive) {
      return { kind: "pill", pillKind: "voice-mode", assistant };
    }

    if (!snapshot.settings.showNotifications) {
      if (assistantActive) return { kind: "pill", pillKind: "voice-mode", assistant };
      return hoverView();
    }
    if (assistantActive) return { kind: "pill", pillKind: "voice-mode", assistant };
    if (items.length > 0) return { kind: "pill", pillKind: "attention", items };
    if (done.length > 0) return { kind: "pill", pillKind: "done", done };
    if (agents.length > 0) return { kind: "pill", pillKind: "running", agents };
    return hoverView();
  }

  const MODE_VIEW = { voice: "voice", attention: "attention", agents: "agents", "done-list": "done-list" };

  // An explicit mode whose content went away (request answered elsewhere, agent finished)
  // falls back to auto so a stale mode never resurrects a card later.
  function normalizeUiMode(view) {
    if (uiMode === "auto" || view.kind === "flash") return;
    if (view.kind !== MODE_VIEW[uiMode]) {
      uiMode = "auto";
      attentionAutoOpened = false;
      threadSwitcherOpen = false;
      cancelAutoCollapse();
    }
  }

  function rimToneFor(view) {
    if (view.kind === "attention" || (view.kind === "pill" && view.pillKind === "attention")) {
      return "attention";
    }
    if (view.kind === "done-list" || (view.kind === "pill" && view.pillKind === "done")) {
      return "done";
    }
    return "normal";
  }

  function applyRimTone(tone) {
    if (tone === currentRimTone) return;
    currentRimTone = tone;
    const next = RIM_TONES[tone] || RIM_TONES.normal;
    rimPathEl.style.stroke = next.stroke;
    rimPathEl.style.filter = next.glow;
  }

  function cancelAutoCollapse() {
    if (autoCollapseTimer) {
      clearTimeout(autoCollapseTimer);
      autoCollapseTimer = null;
    }
  }

  // Like iOS alerts on the Dynamic Island: a new request blooms open on its own, then folds
  // back into the amber pill if the user never reaches for it.
  function scheduleAutoCollapse() {
    cancelAutoCollapse();
    autoCollapseTimer = setTimeout(() => {
      autoCollapseTimer = null;
      if (!isPointerInside && uiMode === "attention" && attentionAutoOpened) {
        uiMode = "auto";
        attentionAutoOpened = false;
        render();
      }
    }, 8000);
  }

  function trackAttention() {
    const rawIds = new Set();
    for (const a of snapshot?.pendingApprovals ?? []) rawIds.add(a.requestId);
    for (const q of snapshot?.pendingUserInputs ?? []) rawIds.add(q.requestId);
    for (const id of [...answeredRequestIds]) if (!rawIds.has(id)) answeredRequestIds.delete(id);
    for (const id of [...seenAttentionIds]) if (!rawIds.has(id)) seenAttentionIds.delete(id);

    const fresh = attentionItems().filter((entry) => !seenAttentionIds.has(entry.requestId));
    for (const entry of fresh) seenAttentionIds.add(entry.requestId);
    if (fresh.length === 0 || uiMode !== "auto" || flashMessage) return;
    if (!snapshot.settings.showNotifications || snapshot.mainWindowFocused) return;
    if ((snapshot.voice && snapshot.voice.phase !== "idle") || snapshot.assistant?.handsFreeActive) {
      return;
    }
    uiMode = "attention";
    attentionKey = fresh[0].requestId;
    attentionAutoOpened = true;
    navDirection = "fade";
    scheduleAutoCollapse();
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

  const ICON_EXPAND =
    '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M9.5 2.5H13.5V6.5M13.5 2.5L9 7M6.5 13.5H2.5V9.5M2.5 13.5L7 9" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_OPEN_APP =
    '<svg width="11.5" height="11.5" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5H12.5V10M12.5 3.5L4 12" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CLOSE =
    '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 4L12 12M12 4L4 12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
  const ICON_CHEVRON_LEFT =
    '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5L5.5 8L10 12.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CHEVRON_RIGHT =
    '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_CHECK =
    '<svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5L6.5 11.5L12.5 4.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const ICON_BRANCH =
    '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.75" stroke="currentColor" stroke-width="1.5"/><circle cx="4.5" cy="12.5" r="1.75" stroke="currentColor" stroke-width="1.5"/><circle cx="11.5" cy="5.5" r="1.75" stroke="currentColor" stroke-width="1.5"/><path d="M4.5 5.25V10.75M11.5 7.25C11.5 9.5 4.5 8.5 4.5 10.75" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const ICON_MIC =
    '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5.75" y="2" width="4.5" height="7.5" rx="2.25" stroke="currentColor" stroke-width="1.5" /><path d="M3.5 7.75a4.5 4.5 0 0 0 9 0M8 12.25V14.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>';
  const ACTIVITY_ICON_PATHS = {
    command: "M3 4.5L6.5 8L3 11.5M8.5 11.5H13",
    edit: "M10.5 2.5L13.5 5.5L6 13H3V10Z",
    read: "M4 2.5H9.5L12 5V13.5H4Z M6.5 8H9.5M6.5 10.5H9.5",
    search: "M10 10L13.5 13.5 M11 7A4 4 0 1 1 3 7A4 4 0 1 1 11 7Z",
    web: "M8 2.5A5.5 5.5 0 1 1 8 13.5A5.5 5.5 0 1 1 8 2.5Z M2.5 8H13.5 M8 2.5C10 4.5 10 11.5 8 13.5 M8 2.5C6 4.5 6 11.5 8 13.5",
    tool: "M10.5 2.5A3 3 0 0 0 7.6 6.3L3 10.9L5.1 13L9.7 8.4A3 3 0 0 0 13.5 5.5L11.7 7.3L10 6.9L9.6 5.2Z",
    agent: "M8 2.5L9.3 6.2L13 7.5L9.3 8.8L8 12.5L6.7 8.8L3 7.5L6.7 6.2Z",
  };

  function activityIcon(kind) {
    const d = ACTIVITY_ICON_PATHS[kind] || ACTIVITY_ICON_PATHS.tool;
    return (
      '<svg class="activity-icon" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="' +
      d +
      '" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    );
  }

  const PROVIDER_COLORS = [
    ["claude", "#d97757"],
    ["codex", "#10a37f"],
    ["openai", "#10a37f"],
    ["cursor", "#8b8bf5"],
    ["antigravity", "#4f8df9"],
    ["gemini", "#4f8df9"],
    ["grok", "#c7c7cc"],
    ["opencode", "#f5a524"],
    ["kiro", "#a78bfa"],
    ["replay", "#64d2ff"],
  ];

  function providerColor(id) {
    const s = String(id || "").toLowerCase();
    for (const [needle, color] of PROVIDER_COLORS) {
      if (s.includes(needle)) return color;
    }
    return "#30d158";
  }

  function providerDot(thread, attrs) {
    return (
      '<span class="provider-dot" style="background:' +
      providerColor(thread?.providerInstanceId) +
      '" ' +
      (attrs || "") +
      "></span>"
    );
  }

  // The lead dot pings once whenever the lead agent's live activity changes; never loops.
  function providerStack(agents) {
    const lead = agents[0];
    const ping = lead
      ? 'data-ping="' + escapeHtml(lead.key + "|" + (lead.currentActivity?.label ?? lead.status)) + '"'
      : "";
    return (
      '<span class="provider-stack">' +
      agents.slice(0, 3).map((t, i) => providerDot(t, i === 0 ? ping : "")).join("") +
      "</span>"
    );
  }

  function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = String(total % 60).padStart(2, "0");
    return hours > 0
      ? hours + ":" + String(minutes).padStart(2, "0") + ":" + seconds
      : minutes + ":" + seconds;
  }

  function durationText(startIso, endIso) {
    const start = Date.parse(startIso || "");
    const end = Date.parse(endIso || "");
    return Number.isFinite(start) && Number.isFinite(end) && end >= start
      ? formatElapsed(end - start)
      : "";
  }

  function agoText(ms) {
    const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (seconds < 60) return "just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return minutes + "m ago";
    return Math.round(minutes / 60) + "h ago";
  }

  // Live timers render empty with data-since and are filled by a 1Hz text-only ticker, so the
  // markup (and its render signature) never changes just because a second passed.
  function elapsedSpan(thread, cls) {
    if (!thread) return "";
    const live = isActiveStatus(thread.status) && !thread.runCompletedAt;
    if (!live) {
      const text = durationText(thread.runStartedAt, thread.runCompletedAt);
      return text ? '<span class="elapsed ' + (cls || "") + '">' + text + "</span>" : "";
    }
    const since = Date.parse(thread.runStartedAt || "");
    return Number.isFinite(since)
      ? '<span class="elapsed ' + (cls || "") + '" data-since="' + since + '"></span>'
      : "";
  }

  function refreshElapsed() {
    const nodes = content.querySelectorAll("[data-since]");
    const now = Date.now();
    for (const node of nodes) {
      const text = formatElapsed(now - Number(node.dataset.since));
      if (node.textContent !== text) node.textContent = text;
    }
  }

  function syncElapsedTicker() {
    const needsTicker = content.querySelector("[data-since]") !== null;
    if (needsTicker && !elapsedTimer) {
      elapsedTimer = setInterval(refreshElapsed, 1000);
    } else if (!needsTicker && elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  function renderPeek() {
    const notchW = metrics.notchWidth;
    const h = metrics.notchHeight + 2;
    const agents = activeAgents();
    const pending = attentionItems().length;
    const left =
      pending > 0
        ? '<span class="status-dot approval"></span>'
        : agents.length > 0
          ? providerStack(agents)
          : '<span class="status-dot idle"></span>';
    const leftAction = pending > 0 ? "expand-attention" : agents.length > 0 ? "expand-agents" : "expand-voice";
    return \`
      <div class="peek-row" style="grid-template-columns:1fr \${notchW}px 1fr;height:\${h}px" data-action="expand-voice" title="Open mattr Island">
        <div class="peek-wing" data-action="\${leftAction}">\${left}</div>
        <div class="notch-cutout"></div>
        <div class="peek-wing" data-action="expand-voice">
          <span class="peek-mic">\${ICON_MIC}</span>
        </div>
      </div>
    \`;
  }

  function renderFlash() {
    if (metrics.hasNotch) {
      const notchW = metrics.notchWidth;
      const h = metrics.notchHeight + 2;
      return \`
        <div class="pill-notched" style="grid-template-columns:1fr \${notchW}px 1fr;height:\${h}px">
          <div class="pill-wing left">
            <span class="done-tick">\${ICON_CHECK}</span>
            <span class="pill-label flash-ok">\${escapeHtml(flashMessage)}</span>
          </div>
          <div class="notch-cutout"></div>
          <div class="pill-wing right"></div>
        </div>
      \`;
    }
    return \`
      <div class="pill-capsule" style="justify-content:center">
        <span class="done-tick">\${ICON_CHECK}</span>
        <span class="pill-label flash-ok">\${escapeHtml(flashMessage)}</span>
      </div>
    \`;
  }

  function pillWidthFor(view) {
    if (!metrics.hasNotch) {
      if (view.kind === "flash") return CAPSULE_FLASH_WIDTH;
      return view.pillKind === "running" ? CAPSULE_RUNNING_WIDTH : CAPSULE_PILL_WIDTH;
    }
    const wing = view.kind === "flash" ? 134 : (PILL_WING[view.pillKind] ?? 134);
    return Math.min(getEffectiveNotchPillWidth(), metrics.notchWidth + wing * 2);
  }

  function renderPill(view) {
    let leftHtml = "";
    let rightHtml = "";
    let rowAction = "expand-voice";
    let rowAttrs = "";

    if (view.pillKind === "voice-mode") {
      const a = view.assistant || {};
      const speaking = Boolean(a.speaking || a.phase === "speaking");
      const thinking = a.phase === "thinking" || a.phase === "acting" || a.phase === "transcribing";
      const listening = a.phase === "listening" || snapshot?.voice?.phase === "recording";
      const dotClass = a.muted ? "approval" : thinking ? "input" : "done";
      const label = a.muted
        ? "Muted"
        : speaking
          ? a.activeBriefingLabel || "Speaking"
          : thinking
            ? a.statusLabel || "Working"
            : listening
              ? "Listening"
              : "Voice Mode";
      const eqClass = a.muted ? "muted" : thinking ? "thinking" : "";
      leftHtml = \`<span class="status-dot \${dotClass}"></span><span class="pill-label">\${escapeHtml(label)}</span>\`;
      rightHtml =
        \`<span id="pill-eq" class="eq-bars \${eqClass}" aria-hidden="true"><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span><span class="eq-bar"></span></span>\` +
        (a.handsFreeActive
          ? \`<button class="pill-btn" data-action="assistant-toggle-hands-free">Stop</button>\`
          : \`<button class="pill-btn" data-action="expand-voice">Open</button>\`);
    } else if (view.pillKind === "running") {
      const agents = view.agents;
      const lead = agents[0];
      rowAction = "expand-agents";
      rowAttrs = \`data-key="\${escapeHtml(lead.key)}"\`;
      leftHtml =
        providerStack(agents) +
        \`<span class="pill-label">\${agents.length === 1 ? "Running" : agents.length + " running"}</span>\`;
      rightHtml = elapsedSpan(lead, "pill-timer");
    } else if (view.pillKind === "done") {
      const items = view.done;
      rowAction = "expand-done";
      leftHtml = \`<span class="done-tick">\${ICON_CHECK}</span><span class="pill-label done-label">Done</span>\`;
      if (items.length === 1) {
        const item = items[0];
        rightHtml = \`<span class="pill-title">\${escapeHtml(item.threadTitle)}</span><button class="pill-btn emerald" data-action="open-thread" data-env="\${escapeHtml(item.environmentId)}" data-thread="\${escapeHtml(item.threadId)}">Review</button>\`;
      } else {
        rightHtml = \`<span class="pill-title">\${items.length} agents</span><button class="pill-btn emerald" data-action="expand-done">Review</button>\`;
      }
    } else {
      const items = view.items;
      const first = items[0];
      rowAction = "expand-attention";
      const label =
        items.length > 1 ? items.length + " pending" : first.kind === "approval" ? "Approve" : "Question";
      leftHtml = \`<span class="status-dot \${first.kind === "approval" ? "approval" : "input"}"></span><span class="pill-label">\${escapeHtml(label)}</span>\`;
      rightHtml = \`<span class="pill-title">\${escapeHtml(first.item.threadTitle)}</span><button class="pill-btn" data-action="expand-attention">Review</button>\`;
    }

    if (metrics.hasNotch) {
      const notchW = metrics.notchWidth;
      const h = metrics.notchHeight + 2;
      return \`
        <div class="pill-notched" style="grid-template-columns:1fr \${notchW}px 1fr;height:\${h}px" data-action="\${rowAction}" \${rowAttrs}>
          <div class="pill-wing left">\${leftHtml}</div>
          <div class="notch-cutout"></div>
          <div class="pill-wing right">\${rightHtml}</div>
        </div>
      \`;
    }

    return \`
      <div class="pill-capsule" data-action="\${rowAction}" \${rowAttrs}>
        \${leftHtml}
        <span style="flex:1"></span>
        \${rightHtml}
      </div>
    \`;
  }

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

  function openInAppButton(environmentId, threadId) {
    return \`<button class="icon-btn" data-action="open-thread" data-env="\${escapeHtml(environmentId)}" data-thread="\${escapeHtml(threadId)}" title="Open in mattr">\${ICON_OPEN_APP}</button>\`;
  }

  const CLOSE_BUTTON = \`<button class="icon-btn" data-action="close-panel" title="Close (Esc)">\${ICON_CLOSE}</button>\`;

  function carouselNav(index, total, scope) {
    if (total <= 1) return "";
    return \`
      <span class="carousel-nav">
        <button class="icon-btn small" data-action="\${scope}-prev" title="Previous (←)">\${ICON_CHEVRON_LEFT}</button>
        <span class="carousel-count">\${index + 1} / \${total}</span>
        <button class="icon-btn small" data-action="\${scope}-next" title="Next (→)">\${ICON_CHEVRON_RIGHT}</button>
      </span>
    \`;
  }

  function renderDoneCard() {
    const done = snapshot?.doneNotifications ?? [];
    const byKey = new Map((snapshot?.recentThreads ?? []).map((t) => [t.key, t]));
    const rows = done.map((d) => {
      const thread = byKey.get(d.key);
      const meta = [thread ? durationText(thread.runStartedAt, thread.runCompletedAt) : "", agoText(d.completedAt)]
        .filter(Boolean)
        .join(" · ");
      return \`
        <div class="done-item" data-action="open-thread" data-env="\${escapeHtml(d.environmentId)}" data-thread="\${escapeHtml(d.threadId)}">
          \${thread ? providerDot(thread) : ""}
          <span class="thread-list-title">\${escapeHtml(d.threadTitle)}</span>
          <span class="thread-list-meta elapsed">\${escapeHtml(meta)}</span>
          <span class="badge-chip emerald">Review</span>
          <button class="icon-btn small" data-action="dismiss-done-item" data-key="\${escapeHtml(d.key)}" title="Dismiss">\${ICON_CLOSE}</button>
        </div>
      \`;
    });
    const headerHtml = renderCardHeader(
      \`<span class="done-tick">\${ICON_CHECK}</span><span class="thread-title-text card-heading">Done · Review</span>\`,
      \`<button class="ghost-btn compact" data-action="dismiss-done">Clear</button>\${CLOSE_BUTTON}\`,
    );
    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body">
          <div class="done-list">\${rows.join("")}</div>
        </div>
      </div>
    \`;
  }

  function renderApproval(approval, navHtml) {
    const opts = approval.options
      .map(
        (opt, idx) => \`
      <button class="option-card" data-action="pick-approval" data-decision="\${escapeHtml(opt.decision)}">
        <span class="option-num">\${idx + 1}</span>
        <span class="option-body">
          <span class="option-label">\${escapeHtml(opt.label)}</span>
          \${opt.warning ? \`<span class="option-desc">\${escapeHtml(opt.warning)}</span>\` : ""}
        </span>
      </button>
    \`,
      )
      .join("");

    const headerHtml = renderCardHeader(
      \`<span class="status-dot approval"></span><span class="thread-title-text card-heading">Approve</span>\`,
      openInAppButton(approval.environmentId, approval.threadId) + CLOSE_BUTTON,
    );

    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body">
          <div class="card-submeta">
            <span class="badge-chip">\${escapeHtml(approval.threadTitle)}</span>
            \${navHtml}
          </div>
          <p class="prompt-heading">\${escapeHtml(approval.title)}</p>
          \${approval.detail ? \`<div class="approval-detail">\${escapeHtml(approval.detail)}</div>\` : ""}
          \${approval.reason ? \`<div class="tool-meta">\${escapeHtml(approval.reason)}</div>\` : ""}
          <div class="option-list">\${opts}</div>
        </div>
      </div>
    \`;
  }

  function renderQuestion(input, navHtml) {
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

    const opts = q.options
      .map((opt, idx) => {
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
      })
      .join("");

    const canSend = Boolean(
      questionCustomText.trim().length > 0 ||
        (Array.isArray(currentAnswer) ? currentAnswer.length > 0 : Boolean(currentAnswer)),
    );
    const isLast = questionIndex >= input.questions.length - 1;

    const headerHtml = renderCardHeader(
      \`<span class="status-dot input"></span><span class="thread-title-text card-heading">Question</span>\${input.questions.length > 1 ? \`<span class="badge-chip blue">\${questionIndex + 1}/\${input.questions.length}</span>\` : ""}\`,
      openInAppButton(input.environmentId, input.threadId) + CLOSE_BUTTON,
    );

    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body">
          <div class="card-submeta">
            <span class="badge-chip">\${escapeHtml(input.threadTitle)}</span>
            \${navHtml}
          </div>
          <p class="prompt-heading">\${escapeHtml(q.question || q.header)}</p>
          <div class="option-list">\${opts}</div>
          \${
            q.allowCustomAnswer !== false
              ? \`
            <input
              id="question-custom-input"
              class="custom-answer-input"
              type="text"
              placeholder="Something else…"
              value="\${escapeHtml(questionCustomText)}"
            />
          \`
              : ""
          }
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

  function renderAttention(view) {
    const nav = carouselNav(view.index, view.total, "attention");
    return view.entry.kind === "approval"
      ? renderApproval(view.entry.item, nav)
      : renderQuestion(view.entry.item, nav);
  }

  const STATUS_CHIPS = {
    running: ["live", "Running"],
    approval: ["amber", "Needs approval"],
    input: ["blue", "Question"],
    done: ["emerald", "Done"],
    failed: ["red", "Failed"],
    limited: ["amber", "Usage limit"],
    idle: ["", "Idle"],
  };

  function threadStatusChip(thread) {
    const [tone, label] = STATUS_CHIPS[thread.status] || STATUS_CHIPS.idle;
    return \`<span class="badge-chip \${tone}">\${label}</span>\`;
  }

  function renderPlan(thread) {
    const plan = thread.plan;
    if (!plan || plan.total <= 0) return "";
    const fraction = clamp(plan.completed / plan.total, 0, 1);
    return \`
      <div class="plan-row" data-plan="\${escapeHtml(thread.key + ":" + plan.completed)}">
        <span class="plan-check">\${ICON_CHECK}</span>
        <span class="plan-count elapsed">\${plan.completed}/\${plan.total}</span>
        <span class="plan-bar"><span class="plan-bar-fill" style="transform:scaleX(\${fraction.toFixed(3)})"></span></span>
        \${plan.currentStep ? \`<span class="plan-step">\${escapeHtml(plan.currentStep)}</span>\` : ""}
      </div>
    \`;
  }

  function renderAgentsCard() {
    const list = agentList();
    if (list.length === 0) return "";
    let index = list.findIndex((t) => t.key === agentKey);
    if (index < 0) index = 0;
    const t = list[index];
    agentKey = t.key;

    const headerHtml = renderCardHeader(
      providerDot(t) +
        \`<span class="thread-title-text card-heading">\${list.length > 1 ? list.length + " agents" : "Agent"}</span>\`,
      openInAppButton(t.environmentId, t.threadId) + CLOSE_BUTTON,
    );

    const metaHtml = [
      t.model
        ? \`<span class="meta-chip">\${providerDot(t)}<span class="meta-text">\${escapeHtml(t.model)}</span></span>\`
        : "",
      t.branch
        ? \`<span class="meta-chip mono">\${ICON_BRANCH}<span class="meta-text">\${escapeHtml(t.branch)}</span></span>\`
        : "",
      elapsedSpan(t, "meta-chip"),
    ].join("");

    const live = isActiveStatus(t.status);
    const now =
      t.currentActivity ||
      (live && t.plan?.currentStep ? { kind: "tool", label: t.plan.currentStep, running: true } : null);
    let activityHtml = "";
    if (now) {
      activityHtml = \`
        <div class="activity-now">
          \${activityIcon(now.kind)}
          <span class="activity-label">\${escapeHtml(now.label)}</span>
          \${now.running ? \`<span class="live-dot" data-ping="\${escapeHtml(t.key + "|" + now.label)}"></span>\` : ""}
        </div>
      \`;
    } else if (t.status === "running") {
      activityHtml = \`<div class="activity-now muted"><span class="activity-label">\${t.isStreaming ? "Writing a reply…" : "Working…"}</span></div>\`;
    }

    const recent = t.recentActivities ?? [];
    const recentHtml =
      recent.length > 0
        ? \`<div class="activity-list">\${recent
            .map(
              (a) =>
                \`<div class="activity-row">\${activityIcon(a.kind)}<span class="activity-label">\${escapeHtml(a.label)}</span></div>\`,
            )
            .join("")}</div>\`
        : "";

    const fallbackHtml =
      !activityHtml && !recentHtml && t.latestAssistantMessage
        ? \`<div class="assistant-text clamp-3">\${escapeHtml(t.latestAssistantMessage)}</div>\`
        : "";

    const stripHtml =
      list.length > 1
        ? \`<div class="agent-strip">\${list
            .slice(0, 6)
            .map(
              (a) =>
                \`<button class="agent-chip \${a.key === t.key ? "active" : ""}" data-action="select-agent" data-key="\${escapeHtml(a.key)}" title="\${escapeHtml(a.title)}">\${providerDot(a)}<span class="agent-chip-title">\${escapeHtml(a.title)}</span></button>\`,
            )
            .join("")}</div>\`
        : "";

    const reviewHtml =
      t.status === "approval" || t.status === "input"
        ? \`<button class="ghost-btn" data-action="expand-attention" data-thread="\${escapeHtml(t.threadId)}">\${t.status === "approval" ? "Review approval" : "Answer question"}</button>\`
        : "";

    return \`
      <div class="card-root">
        \${headerHtml}
        <div class="card-body">
          <div class="card-submeta">
            \${threadStatusChip(t)}
            \${carouselNav(index, list.length, "agents")}
          </div>
          <button class="agent-title" data-action="open-thread" data-env="\${escapeHtml(t.environmentId)}" data-thread="\${escapeHtml(t.threadId)}" title="Open in mattr">\${escapeHtml(t.title)}</button>
          \${metaHtml ? \`<div class="meta-row">\${metaHtml}</div>\` : ""}
          \${activityHtml}
          \${recentHtml}
          \${renderPlan(t)}
          \${fallbackHtml}
          \${stripHtml}
          <div class="card-footer">
            \${reviewHtml}
            <button class="primary-pill-btn" data-action="open-thread" data-env="\${escapeHtml(t.environmentId)}" data-thread="\${escapeHtml(t.threadId)}">Open in mattr</button>
          </div>
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
        ? \`<button class="badge-chip amber" style="border:none;cursor:pointer" data-action="expand-attention">Approve</button>\`
        : (snapshot?.pendingUserInputs?.length ?? 0) > 0
          ? \`<button class="badge-chip blue" style="border:none;cursor:pointer" data-action="expand-attention">Question</button>\`
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
        <div class="card-body">
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

  function syncCardHeightTarget(profile) {
    if (geomState !== "card") return;
    const { stageH } = syncStageSize();
    const cardW = getEffectiveCardWidth();
    measureEl.style.width = cardW + "px";
    const rectH = Math.ceil(measureEl.getBoundingClientRect().height || 0);
    const scrollH = Math.ceil(measureEl.scrollHeight || 0);
    const measured = Math.max(rectH, scrollH, 92) + 4;
    const maxH = Math.max(200, Math.min(540, stageH - 16));
    setSpringTargets(
      {
        w: cardW,
        h: clamp(measured, 96, maxH),
        earR: metrics.hasNotch ? 16 : 0,
        botR: 26,
        expand: 1,
        presence: 1,
      },
      { profile: profile || "auto" },
    );
  }

  function contentWidthFor(view) {
    if (view.kind === "peek") return metrics.notchWidth + PEEK_WING * 2;
    if (view.kind === "pill" || view.kind === "flash") return pillWidthFor(view);
    return getEffectiveCardWidth();
  }

  function syncGeometryForView(view) {
    const prevState = geomState;
    const prevRank = GEOM_RANK[prevState] ?? 0;
    const nW = metrics.notchWidth;
    const nH = metrics.notchHeight;
    const hover = isHoverNudge && isPointerInside ? 1 : 0;
    const hoverChanged = hover !== lastGeomHover;
    lastGeomHover = hover;
    let next;
    let targets;

    if (view.kind === "hidden") {
      if (metrics.hasNotch && snapshot?.settings?.enabled !== false) {
        next = "docked";
        targets = { w: nW, h: nH, earR: 6, botR: 11, expand: 0, presence: 1 };
      } else {
        next = "hidden";
        targets = { w: 220, h: 34, earR: 0, botR: 17, expand: 0, presence: 0 };
      }
    } else if (view.kind === "nudge") {
      // 0ms hover response: the silhouette stretches out of the hardware notch immediately.
      next = "nudge";
      targets = { w: nW + 10, h: nH + 5, earR: 7, botR: 13, expand: 0.16, presence: 1 };
    } else if (view.kind === "peek") {
      next = "peek";
      targets = {
        w: nW + PEEK_WING * 2 + hover * 10,
        h: nH + 2 + hover * 5,
        earR: 8,
        botR: 14,
        expand: 0.3,
        presence: 1,
      };
    } else if (view.kind === "pill" || view.kind === "flash") {
      next = "pill";
      const pillW = pillWidthFor(view);
      targets = metrics.hasNotch
        ? { w: pillW + hover * 10, h: nH + 2 + hover * 5, earR: 8, botR: 14, expand: 0.52, presence: 1 }
        : { w: pillW + hover * 10, h: 38 + hover * 4, earR: 0, botR: 19 + hover * 2, expand: 0.52, presence: 1 };
    } else {
      geomState = "card";
      syncCardHeightTarget(prevState === "card" ? "auto" : "open");
      return;
    }

    const nextRank = GEOM_RANK[next];
    const hoverOnly = next === "nudge" || prevState === "nudge" || (nextRank === prevRank && hoverChanged);
    const profile = hoverOnly
      ? "peek"
      : nextRank > prevRank
        ? "open"
        : nextRank < prevRank
          ? "close"
          : "auto";
    geomState = next;
    setSpringTargets(targets, { profile });
  }

  function clearOutgoingLayers() {
    for (const layer of contentClipEl.querySelectorAll(".morph-layer")) layer.remove();
  }

  // Outgoing content dissolves (blur + scale toward the top edge) on its own layer while the
  // incoming view resolves inside the reshaping blob.
  function spawnOutgoing(direction) {
    clearOutgoingLayers();
    const old = content.firstElementChild;
    if (!old || prefersReducedMotion) return;
    const width = measureEl.offsetWidth;
    const layer = document.createElement("div");
    layer.className =
      "morph-layer " +
      (direction === "next" ? "slide-out-next" : direction === "prev" ? "slide-out-prev" : "morph-out");
    layer.style.width = width + "px";
    layer.style.marginLeft = -width / 2 + "px";
    layer.setAttribute("aria-hidden", "true");
    for (const node of old.querySelectorAll("[id]")) node.removeAttribute("id");
    for (const node of old.querySelectorAll("[data-since]")) node.removeAttribute("data-since");
    layer.appendChild(old);
    contentClipEl.appendChild(layer);
    const remove = () => layer.remove();
    layer.addEventListener("animationend", (event) => {
      if (event.target === layer) remove();
    });
    setTimeout(remove, 260);
  }

  function applyEnterAnimation() {
    const el = content.firstElementChild;
    if (!el) return;
    const sliding = morphDirection === "next" || morphDirection === "prev";
    const delay = sliding ? SLIDE_ENTER_DELAY_MS : MORPH_ENTER_DELAY_MS;
    const elapsed = performance.now() - morphStartedAt;
    if (elapsed >= delay + MORPH_ENTER_DURATION_MS) return;
    const cls =
      morphDirection === "next" ? "slide-in-next" : morphDirection === "prev" ? "slide-in-prev" : "morph-in";
    el.classList.add(cls);
    // A data re-render mid-transition resumes the same animation instead of restarting it.
    el.style.animationDelay = Math.round(delay - elapsed) + "ms";
    el.addEventListener("animationend", (event) => {
      if (event.target !== el) return;
      el.classList.remove(cls);
      el.style.animationDelay = "";
    });
  }

  function afterContentCommit() {
    refreshElapsed();
    syncElapsedTicker();
    const pingEl = content.querySelector("[data-ping]");
    if (pingEl) {
      const sig = pingEl.dataset.ping;
      if (lastPingSignature && sig !== lastPingSignature) pingEl.classList.add("ping");
      lastPingSignature = sig;
    }
    const planEl = content.querySelector("[data-plan]");
    if (planEl) {
      const sig = planEl.dataset.plan;
      const [key] = sig.split(":");
      if (lastPlanSignature.startsWith(key + ":") && sig !== lastPlanSignature) {
        planEl.classList.add("tick");
      }
      lastPlanSignature = sig;
    }
  }

  function commitContent(view, signature, build, morphKey, direction) {
    const keyChanged = morphKey !== lastMorphKey;
    if (!keyChanged && signature === lastRenderedSignature) return;
    const active = document.activeElement;
    const focusId = active && content.contains(active) && active.id ? active.id : "";
    let selStart = null;
    let selEnd = null;
    if (focusId) {
      try {
        selStart = active.selectionStart;
        selEnd = active.selectionEnd;
      } catch {}
    }
    if (keyChanged) {
      if (lastMorphKey) spawnOutgoing(direction);
      morphStartedAt = performance.now();
      morphDirection = direction;
    }
    measureEl.style.width = contentWidthFor(view) + "px";
    content.innerHTML = build();
    lastRenderedSignature = signature;
    lastMorphKey = morphKey;
    if (focusId && !keyChanged) {
      const nextFocus = document.getElementById(focusId);
      if (nextFocus) {
        nextFocus.focus();
        if (selStart !== null && selEnd !== null) {
          try {
            nextFocus.setSelectionRange(selStart, selEnd);
          } catch {}
        }
      }
    }
    applyEnterAnimation();
    afterContentCommit();
  }

  function dissolveContent() {
    if (!lastMorphKey) return;
    spawnOutgoing("fade");
    content.innerHTML = "";
    lastMorphKey = "";
    lastRenderedSignature = "hidden";
    syncElapsedTicker();
  }

  function voiceSignature() {
    return JSON.stringify({
      hasNotch: metrics.hasNotch,
      notchWidth: metrics.notchWidth,
      notchHeight: metrics.notchHeight,
      switcher: threadSwitcherOpen,
      thread: selectedThread(),
      threadsCount: snapshot?.recentThreads?.length ?? 0,
      attention: attentionItems().length,
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
    });
  }

  function render() {
    const view = resolveEffectiveView();
    normalizeUiMode(view);
    applyRimTone(rimToneFor(view));

    if (view.kind === "hidden" || view.kind === "nudge") {
      stopWaveLoop();
      dissolveContent();
      syncGeometryForView(view);
      if (!isPointerInside) setPassthrough(true);
      return;
    }

    if (view.kind !== "voice") destroyWaveGl();
    const direction = navDirection;
    navDirection = "fade";

    if (view.kind === "voice") {
      commitContent(view, voiceSignature(), () => renderVoicePanel(), "voice", "fade");
      ensureWaveMounted();
      syncGeometryForView(view);
      return;
    }

    let html = "";
    let morphKey = view.kind;
    let morphDir = "fade";
    if (view.kind === "peek") {
      html = renderPeek();
    } else if (view.kind === "flash") {
      html = renderFlash();
    } else if (view.kind === "pill") {
      html = renderPill(view);
      morphKey = "pill:" + view.pillKind;
    } else if (view.kind === "done-list") {
      html = renderDoneCard();
    } else if (view.kind === "attention") {
      html = renderAttention(view);
      morphKey = "attention:" + view.entry.requestId + ":" + questionIndex;
      morphDir = direction;
    } else if (view.kind === "agents") {
      html = renderAgentsCard();
      morphKey = "agents:" + agentKey;
      morphDir = direction;
    }
    commitContent(view, html, () => html, morphKey, morphDir);
    if (view.kind === "pill") updatePillEqualizer();
    syncGeometryForView(view);
  }

  function decisionLabel(decision) {
    return decision === "accept"
      ? "Allowed once"
      : decision === "acceptAlways"
        ? "Always allowed"
        : decision === "acceptForSession"
          ? "Allowed for session"
          : "Denied";
  }

  // After answering, slide to the next pending request; flash a confirmation only once the
  // carousel is empty.
  function finishAttentionItem(label) {
    attentionKey = null;
    if (uiMode === "attention" && attentionItems().length > 0) {
      navDirection = "next";
      render();
      return;
    }
    uiMode = "auto";
    attentionAutoOpened = false;
    showFlash(label);
  }

  function respondApproval(approval, decision) {
    if (!approval || !decision) return;
    bridge.sendAction({
      type: "respond-approval",
      environmentId: approval.environmentId,
      threadId: approval.threadId,
      requestId: approval.requestId,
      decision,
    });
    answeredRequestIds.add(approval.requestId);
    finishAttentionItem(decisionLabel(decision));
  }

  function currentQuestionInput() {
    const entry = currentAttentionEntry();
    return entry && entry.kind === "question" ? entry.item : null;
  }

  function pickQuestionOption(q, value) {
    questionCustomText = "";
    if (q.multiSelect) {
      const cur = Array.isArray(questionAnswers[q.id]) ? [...questionAnswers[q.id]] : [];
      const i = cur.indexOf(value);
      if (i >= 0) cur.splice(i, 1);
      else cur.push(value);
      questionAnswers[q.id] = cur;
      render();
      return;
    }
    questionAnswers[q.id] = value;
    render();
    setTimeout(() => submitCurrentQuestion(), 140);
  }

  function submitCurrentQuestion() {
    const input = currentQuestionInput();
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
      navDirection = "next";
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
    answeredRequestIds.add(input.requestId);
    questionIndex = 0;
    questionAnswers = {};
    questionCustomText = "";
    activeRequestId = null;
    finishAttentionItem("Sent");
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
    isHoverNudge = false;
    attentionAutoOpened = false;
    cancelAutoCollapse();
    uiMode = "auto";
    bridge.sendAction({ type: "voice-cancel" });
    bridge.sendAction({ type: "close-panel" });
    render();
  }

  function openMode(mode) {
    uiMode = mode;
    isNotchPeeking = false;
    attentionAutoOpened = false;
    cancelAutoCollapse();
    bridge.focusWindow();
    lastPassthrough = false;
    render();
  }

  function stepAttention(delta) {
    const items = attentionItems();
    const cur = currentAttention(items);
    if (!cur || cur.total < 2) return;
    const next = (cur.index + delta + cur.total) % cur.total;
    attentionIndex = next;
    attentionKey = items[next].requestId;
    navDirection = delta > 0 ? "next" : "prev";
    render();
  }

  function stepAgent(delta) {
    const list = agentList();
    if (list.length < 2) return;
    const index = Math.max(0, list.findIndex((t) => t.key === agentKey));
    const next = (index + delta + list.length) % list.length;
    agentKey = list[next].key;
    navDirection = delta > 0 ? "next" : "prev";
    render();
  }

  function focusDraftSoon(delay) {
    setTimeout(() => document.getElementById("island-draft-input")?.focus(), delay);
  }

  function openVoicePanel() {
    openMode("voice");
    focusDraftSoon(60);
  }

  // Click delegation on active Island content
  contentClipEl.addEventListener("click", (event) => {
    const target = event.target.closest("[data-action]");
    if (!target) return;
    const action = target.dataset.action;
    switch (action) {
      case "open-thread": {
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
      case "expand-done":
        openMode("done-list");
        return;
      case "expand-attention":
      case "expand-approval":
      case "expand-question": {
        const threadId = target.dataset.thread;
        if (threadId) {
          const match = attentionItems().find((entry) => entry.item.threadId === threadId);
          if (match) attentionKey = match.requestId;
        }
        navDirection = "fade";
        openMode("attention");
        return;
      }
      case "expand-agents":
        if (target.dataset.key) agentKey = target.dataset.key;
        navDirection = "fade";
        openMode("agents");
        return;
      case "attention-prev":
        stepAttention(-1);
        return;
      case "attention-next":
        stepAttention(1);
        return;
      case "agents-prev":
        stepAgent(-1);
        return;
      case "agents-next":
        stepAgent(1);
        return;
      case "select-agent": {
        const list = agentList();
        const from = list.findIndex((t) => t.key === agentKey);
        const to = list.findIndex((t) => t.key === target.dataset.key);
        if (to < 0 || to === from) return;
        agentKey = target.dataset.key;
        navDirection = to > from ? "next" : "prev";
        render();
        return;
      }
      case "dismiss-done":
        bridge.sendAction({ type: "dismiss-done" });
        uiMode = "auto";
        render();
        return;
      case "dismiss-done-item":
        event.stopPropagation();
        bridge.sendAction({ type: "dismiss-done", key: target.dataset.key });
        return;
      case "close-panel":
        closeIsland();
        return;
      case "toggle-thread-switcher":
        threadSwitcherOpen = !threadSwitcherOpen;
        render();
        return;
      case "select-thread":
        threadSwitcherOpen = false;
        bridge.sendAction({ type: "select-thread", threadKey: target.dataset.key });
        render();
        return;
      case "voice-toggle":
        if (!snapshot?.voice?.available) {
          bridge.sendAction({ type: "open-voice-settings" });
          return;
        }
        bridge.sendAction({ type: "voice-toggle" });
        return;
      case "expand-voice":
        openVoicePanel();
        return;
      case "assistant-set-mode":
        if (target.dataset.mode) {
          bridge.sendAction({ type: "assistant-set-mode", mode: target.dataset.mode });
        }
        return;
      case "assistant-toggle-hands-free":
        event.stopPropagation();
        bridge.sendAction({ type: "assistant-toggle-hands-free" });
        return;
      case "assistant-toggle-mute":
        event.stopPropagation();
        bridge.sendAction({ type: "assistant-toggle-mute" });
        return;
      case "assistant-barge-in":
        bridge.sendAction({ type: "assistant-barge-in" });
        return;
      case "assistant-open-voice-mode-modal":
        uiMode = "auto";
        isNotchPeeking = false;
        bridge.sendAction({ type: "assistant-open-voice-mode-modal" });
        render();
        return;
      case "send-reply":
        submitVoiceReply();
        return;
      case "pick-approval": {
        const entry = currentAttentionEntry();
        if (entry && entry.kind === "approval") respondApproval(entry.item, target.dataset.decision);
        return;
      }
      case "pick-question-option": {
        const input = currentQuestionInput();
        const q = input?.questions.find((item) => item.id === target.dataset.qid);
        if (q) pickQuestionOption(q, target.dataset.value);
        return;
      }
      case "dismiss-question": {
        const input = currentQuestionInput();
        if (!input) return;
        bridge.sendAction({
          type: "dismiss-user-input",
          environmentId: input.environmentId,
          threadId: input.threadId,
          requestId: input.requestId,
        });
        answeredRequestIds.add(input.requestId);
        finishAttentionItem("Skipped");
        return;
      }
      case "submit-question":
        submitCurrentQuestion();
        return;
    }
  });

  // Clicking transparent margin outside an expanded card dismisses it;
  // clicking directly inside the (hover-stretched) notch immediately opens Voice Assistant
  stage.addEventListener("click", (event) => {
    if (event.target !== stage) return;
    if (
      (geomState === "docked" || geomState === "nudge") &&
      metrics.hasNotch &&
      isPointInsideIsland(event.clientX, event.clientY)
    ) {
      openVoicePanel();
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

  // Keyboard: Escape, Enter, 1-9 for options, ←/→ for carousels, Cmd+Enter to open in mattr
  window.addEventListener("keydown", (event) => {
    const view = resolveEffectiveView();
    if (event.key === "Escape") {
      event.preventDefault();
      closeIsland();
      return;
    }
    const typing = document.activeElement?.tagName === "INPUT";
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
      if (view.kind === "attention" && view.entry.kind === "question") {
        event.preventDefault();
        submitCurrentQuestion();
        return;
      }
      if (view.kind === "agents" && !typing) {
        const t = agentList().find((item) => item.key === agentKey);
        if (t) {
          event.preventDefault();
          bridge.sendAction({ type: "open-thread", environmentId: t.environmentId, threadId: t.threadId });
        }
        return;
      }
    }
    if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const delta = event.key === "ArrowRight" ? 1 : -1;
      if (view.kind === "attention") {
        event.preventDefault();
        stepAttention(delta);
      } else if (view.kind === "agents") {
        event.preventDefault();
        stepAgent(delta);
      }
      return;
    }
    const digit = Number.parseInt(event.key, 10);
    if (!(digit >= 1 && digit <= 9) || view.kind !== "attention") return;
    if (view.entry.kind === "approval") {
      const opt = view.entry.item.options[digit - 1];
      if (opt) {
        event.preventDefault();
        respondApproval(view.entry.item, opt.decision);
      }
      return;
    }
    const input = view.entry.item;
    const q = input.questions[questionIndex] ?? input.questions[0];
    const opt = q?.options[digit - 1];
    if (q && opt) {
      event.preventDefault();
      pickQuestionOption(q, opt.value);
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
      // Strictly confined to the physical camera cutout
      const halfHitW = Math.min(100, metrics.notchWidth / 2);
      return x >= cx - halfHitW && x <= cx + halfHitW && y >= 0 && y <= metrics.notchHeight;
    }

    const liveW = Math.max(springs.w.pos, springs.w.target * 0.85);
    const liveH = Math.max(springs.h.pos, springs.h.target * 0.85);
    const earPad = metrics.hasNotch ? springs.earR.pos * 0.45 : 0;
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

  function onPointerEnterIsland() {
    cancelAutoCollapse();
    if (attentionAutoOpened) {
      // The user reached for an auto-opened request: take focus so keys and clicks land.
      attentionAutoOpened = false;
      bridge.focusWindow();
      lastPassthrough = false;
    }
    if (geomState === "card") return;
    const wasDocked = geomState === "docked";
    isHoverNudge = true;
    render();
    if (wasDocked && metrics.hasNotch && !isNotchPeeking && !peekEnterTimer) {
      peekEnterTimer = setTimeout(() => {
        peekEnterTimer = null;
        if (isPointerInside && !isNotchPeeking && geomState === "nudge") {
          isNotchPeeking = true;
          render();
        }
      }, 140);
      return;
    }
    const view = resolveEffectiveView();
    if (view.kind === "pill" && view.pillKind === "attention") {
      if (hoverExpandTimer) clearTimeout(hoverExpandTimer);
      hoverExpandTimer = setTimeout(() => {
        hoverExpandTimer = null;
        if (!isPointerInside) return;
        const cur = resolveEffectiveView();
        if (cur.kind === "pill" && cur.pillKind === "attention") {
          navDirection = "fade";
          openMode("attention");
        }
      }, 220);
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
    const hadNudge = isHoverNudge;
    isHoverNudge = false;
    if (isNotchPeeking) {
      if (!peekLeaveTimer) {
        peekLeaveTimer = setTimeout(() => {
          peekLeaveTimer = null;
          if (!isPointerInside && isNotchPeeking) {
            isNotchPeeking = false;
            render();
          }
        }, 110);
      }
      if (hadNudge) render();
    } else if (hadNudge) {
      render();
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
      if (!wasInside) onPointerEnterIsland();
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
    isHoverNudge = false;
    const voiceActive = snapshot?.voice && snapshot.voice.phase !== "idle";
    if (!voiceActive && uiMode !== "auto") {
      uiMode = "auto";
      attentionAutoOpened = false;
      threadSwitcherOpen = false;
    }
    render();
  });

  // Display metrics from DesktopIsland (notched vs external monitor)
  function applyDisplayMetrics(next) {
    if (!next || typeof next !== "object") return;
    const changedNotch = next.hasNotch !== metrics.hasNotch;
    metrics = {
      hasNotch: Boolean(next.hasNotch),
      notchWidth: Number(next.notchWidth) || 200,
      notchHeight: Number(next.notchHeight) || 37,
      windowWidth: Number(next.windowWidth) || 560,
    };
    syncStageSize();
    if (!metrics.hasNotch) {
      isNotchPeeking = false;
      isHoverNudge = false;
    }
    if (changedNotch && geomState !== "card") {
      setSpringTargets(
        metrics.hasNotch
          ? { w: metrics.notchWidth, h: metrics.notchHeight, earR: 6, botR: 11, expand: 0, presence: 1 }
          : { w: 220, h: 34, earR: 0, botR: 17, expand: 0, presence: 0 },
        { immediate: true },
      );
    }
    lastRenderedSignature = "";
    render();
  }

  // Continuously track card height changes (messages, transcripts, switcher, fonts)
  if (typeof ResizeObserver === "function") {
    const ro = new ResizeObserver(() => {
      if (geomState === "card") {
        syncCardHeightTarget("auto");
      }
    });
    ro.observe(measureEl);
  }

  window.addEventListener("resize", () => {
    syncStageSize();
    lastRenderedSignature = "";
    render();
    applyGeometryFrame();
  });

  if (typeof bridge.onDisplayMetrics === "function") {
    bridge.onDisplayMetrics((next) => applyDisplayMetrics(next));
  }

  bridge.onSnapshot((next) => {
    snapshot = next;
    trackAttention();
    if (snapshot.mainWindowFocused && attentionAutoOpened && uiMode === "attention") {
      uiMode = "auto";
      attentionAutoOpened = false;
      cancelAutoCollapse();
    }
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
      openMode("voice");
      if (command.startVoice && snapshot?.voice?.available && snapshot?.voice?.phase === "idle") {
        bridge.sendAction({ type: "voice-start" });
      } else {
        focusDraftSoon(50);
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
        return;
      }
      openMode("voice");
      if (command.startVoice && snapshot?.voice?.available) {
        bridge.sendAction({ type: "voice-start" });
      } else {
        focusDraftSoon(50);
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
