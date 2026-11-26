import { ISLAND_PROVIDER_GLYPHS, ISLAND_PROVIDER_MONOGRAMS } from "./islandGlyphs.ts";
import { islandModelRuntime } from "./islandModel.ts";
import {
  ISLAND_CONTENT_TRANSITIONS,
  ISLAND_SPRINGS,
  islandMotionCssVariables,
} from "./islandMotion.ts";
import { SIRI_FLUID_DOTS_FRAG, SIRI_WAVE_FRAG, SIRI_WAVE_VERT } from "./siriWaveShaders.ts";

/**
 * The notch renderer ("Pulse Deck + Drop"): a self-contained data: URL document. Shape and size
 * move with CSS transitions on spring-sampled `linear()` easings, so nothing runs once a state
 * settles. The pure logic is `islandModelRuntime`, embedded by source.
 */
export function buildIslandHtml(): string {
  const shadersJson = JSON.stringify({
    vert: SIRI_WAVE_VERT,
    wave: SIRI_WAVE_FRAG,
    fluidDots: SIRI_FLUID_DOTS_FRAG,
  });
  const glyphsJson = JSON.stringify({
    marks: ISLAND_PROVIDER_GLYPHS,
    monograms: ISLAND_PROVIDER_MONOGRAMS,
  });
  const reducedMotionVars = Object.keys(ISLAND_SPRINGS)
    .map((name) => `--island-dur-${name}: 0ms;`)
    .join(" ");
  const t = ISLAND_CONTENT_TRANSITIONS;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Matter Island</title>
<style>
  @property --ear { syntax: "<length>"; inherits: true; initial-value: 0px; }
  @property --br { syntax: "<length>"; inherits: true; initial-value: 10px; }
  :root {
    ${islandMotionCssVariables()}
    --fg: #f5f5f7;
    --muted: rgba(245, 245, 247, 0.6);
    --subtle: rgba(245, 245, 247, 0.5);
    --line: rgba(255, 255, 255, 0.08);
    --surface: rgba(255, 255, 255, 0.09);
    --surface-hover: rgba(255, 255, 255, 0.12);
    --amber: #ff9f0a;
    --red: #ff453a;
    --green: #34d399;
    --send: #e5484d;
    --notch-w: 200px;
    --notch-h: 32px;
    --wing-w: 36px;
    --content-w: 420px;
    --shell-ease: var(--island-ease-settle);
    --shell-dur: var(--island-dur-settle);
    --sx: 1;
    --sy: 1;
  }
  @media (prefers-reduced-motion: reduce) {
    :root { ${reducedMotionVars} }
    .swap-in, .content-in, .content-out { animation: none !important; }
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent;
    color: var(--fg); font: 13px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; user-select: none; cursor: default;
  }
  #shell {
    position: absolute; top: 0; left: 50%; width: var(--notch-w); height: var(--notch-h);
    background: #000; border-radius: 0 0 var(--br) var(--br);
    transform: translateX(-50%) scale(var(--sx), var(--sy)); transform-origin: 50% 0;
    transition:
      width var(--shell-dur) var(--shell-ease),
      height var(--shell-dur) var(--shell-ease),
      --ear var(--shell-dur) var(--shell-ease),
      --br var(--shell-dur) var(--shell-ease),
      transform var(--island-dur-hover) var(--island-ease-hover),
      opacity 160ms ease-out;
  }
  @supports (corner-shape: superellipse(1.4)) { #shell { corner-shape: superellipse(1.4); } }
  #shell::before, #shell::after {
    content: ""; position: absolute; top: 0; width: var(--ear); height: var(--ear); pointer-events: none;
  }
  #shell::before { right: 100%; background: radial-gradient(circle at 0 100%, transparent calc(var(--ear) - 0.5px), #000 var(--ear)); }
  #shell::after { left: 100%; background: radial-gradient(circle at 100% 100%, transparent calc(var(--ear) - 0.5px), #000 var(--ear)); }
  #shell.pill { top: 6px; border-radius: var(--br); }
  #shell.pill::before, #shell.pill::after { display: none; }
  #shell.is-hidden { opacity: 0; transition-delay: 0ms, 0ms, 0ms, 0ms, 0ms, var(--island-dur-collapse); }
  #shell.is-pressed { transition-duration: var(--shell-dur), var(--shell-dur), var(--shell-dur), var(--shell-dur), var(--island-dur-press), 160ms; transition-timing-function: var(--shell-ease), var(--shell-ease), var(--shell-ease), var(--shell-ease), var(--island-ease-press), ease-out; }
  #clip { position: absolute; inset: 0; overflow: hidden; border-radius: inherit; }
  #wings {
    position: absolute; top: 0; left: 50%; height: var(--notch-h); transform: translateX(-50%);
    display: flex; align-items: center; pointer-events: none;
  }
  .wing { width: var(--wing-w); height: 100%; display: flex; align-items: center; justify-content: center;
    transition: width var(--shell-dur) var(--shell-ease), transform var(--shell-dur) var(--shell-ease); }
  .gap { width: var(--notch-w); height: 100%; flex: none; transition: width var(--shell-dur) var(--shell-ease); }
  .wing > * { flex: none; }
  .glyph { width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; color: var(--fg); }
  .glyph svg { width: 16px; height: 16px; fill: currentColor; }
  .glyph.monogram { flex: none; font-weight: 600; font-size: 9.5px; line-height: 1; border-radius: 4px; background: none; border: 1.25px solid rgba(255,255,255,0.55); }
  .ring-wrap { display: inline-flex; }
  .ring { width: 16px; height: 16px; }
  .ring circle { fill: none; stroke-width: 2.25; }
  .dots { display: flex; gap: 3px; }
  .dots i { width: 4px; height: 4px; border-radius: 2px; background: rgba(255,255,255,0.3); }
  .dots i.on { background: var(--fg); }
  .count { font-variant-numeric: tabular-nums; font-weight: 560; font-size: 13px; }
  .amber { display: flex; align-items: center; gap: 4px; }
  .amber i { width: 8px; height: 8px; border-radius: 4px; background: var(--amber); }
  .amber .count { color: var(--amber); font-size: 12px; }
  .bang { color: var(--red); font-weight: 800; font-size: 15px; }
  .check.is-done svg { transform: translateY(1px); }
  .check svg { width: 15px; height: 15px; stroke: var(--fg); fill: none; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
  #wave { width: 56px; height: 24px; display: block; }
  .swap-in { animation: island-swap var(--island-dur-morph) var(--island-ease-morph) both; }
  @keyframes island-swap {
    from { opacity: 0; transform: scale(${t.swap.scale}); filter: blur(${t.swap.blur}px); }
    to { opacity: 1; transform: none; filter: none; }
  }
  #panel { position: absolute; top: var(--notch-h); left: 50%; transform: translateX(-50%); width: var(--content-w); }
  #panel-inner { position: relative; padding: 6px 14px 16px; max-height: calc(100vh - var(--notch-h) - 8px); overflow-y: auto; scrollbar-width: none; }
  .content-in { animation: island-in ${t.insert.durationMs}ms cubic-bezier(0.22, 1, 0.36, 1) ${t.insert.delayMs}ms both; }
  .content-out { position: absolute; top: 0; left: 0; right: 0; pointer-events: none;
    animation: island-out ${t.remove.durationMs}ms cubic-bezier(0.4, 0, 1, 1) both; }
  @keyframes island-in {
    from { opacity: 0; filter: blur(${t.insert.blur}px); transform: translateY(${t.insert.y}px); }
    to { opacity: 1; filter: none; transform: none; }
  }
  @keyframes island-out {
    from { opacity: 1; filter: none; transform: none; }
    to { opacity: 0; filter: blur(${t.remove.blur}px); transform: translateY(${t.remove.y}px); }
  }
  button { font: inherit; color: inherit; background: none; border: 0; padding: 0; cursor: default; }
  .row { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 12px; min-height: 40px; }
  .row.is-selected, .row[data-action]:hover { background: var(--surface); }
  .row .text { flex: 1; min-width: 0; }
  /* 500, not ~520: weights above 500 snap to Semibold when the system font is not variable. */
  .row .title { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .detail { color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .row .meta { color: var(--subtle); font-size: 11.5px; font-variant-numeric: tabular-nums; flex: none; }
  .row .state-dot { width: 6px; height: 6px; border-radius: 3px; flex: none; }
  .row .meta.running { color: var(--green); }
  .row .status { display: inline-flex; align-items: center; gap: 6px; flex: none; }
  .state-dot.running { background: var(--green); }
  .state-dot.needs { background: var(--amber); }
  .state-dot.failed { background: var(--red); }
  .state-dot.done { background: rgba(255,255,255,0.24); }
  .btn { height: 28px; padding: 0 12px; border-radius: 9px; background: var(--surface); font-weight: 500; font-size: 12.5px; white-space: nowrap; }
  .btn:hover { background: var(--surface-hover); }
  .btn.primary { background: #fff; color: #000; }
  .btn.primary:hover { background: rgba(255,255,255,0.86); }
  .btn.small { height: 24px; padding: 0 9px; font-size: 12px; border-radius: 8px; }
  .btn kbd { font: inherit; font-weight: 450; opacity: 0.5; margin-left: 5px; }
  .btn kbd.sym { font-family: "SF Pro Text", -apple-system, "Apple Symbols", sans-serif; font-size: 12px; font-weight: 400; letter-spacing: 0.04em; opacity: 0.6; }
  .btn.primary[disabled] { background: var(--surface); color: var(--subtle); }
  .btn.primary[disabled]:hover { background: var(--surface); }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; margin-top: 12px; }
  .actions .spacer { flex: 1; }
  .empty { color: var(--muted); padding: 10px 8px 4px; }
  .empty b { color: var(--fg); font-weight: 500; }
  .head { display: flex; align-items: center; gap: 8px; padding: 2px 2px 8px; color: var(--muted); font-size: 12px; }
  .head .title { color: var(--muted); font-weight: 500; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head .pager { font-variant-numeric: tabular-nums; }
  .card-title { font-weight: 600; font-size: 14px; margin: 2px 2px 6px; }
  .question-text { margin: 0 2px 6px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; text-wrap: pretty; }
  .mono { font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace; background: var(--surface); border-radius: 10px;
    padding: 8px 10px; color: var(--fg); white-space: pre-wrap; word-break: break-word; display: -webkit-box;
    -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .muted { color: var(--muted); }
  .reason { color: var(--muted); font-size: 12px; margin: 6px 2px 0; text-wrap: pretty; }
  .options { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; max-height: 248px; overflow-y: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.2) transparent; }
  .options.has-more { mask-image: linear-gradient(to bottom, #000 calc(100% - 56px), transparent); }
  .option { display: flex; align-items: center; gap: 10px; padding: 7px 8px; border-radius: 10px; text-align: left; }
  .option:hover { background: var(--surface); }
  .option.is-picked { background: var(--surface-hover); }
  .option .letter { width: 20px; height: 20px; border-radius: 6px; flex: none; display: inline-flex; align-items: center;
    justify-content: center; font-size: 11px; font-weight: 560; background: var(--surface); color: var(--muted); }
  .option.is-picked .letter { background: #fff; color: #000; }
  .option .desc { color: var(--muted); font-size: 12px; }
  .steps { margin: 2px 2px 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; line-height: 18px; }
  .steps li { display: flex; align-items: flex-start; gap: 10px; color: var(--fg); }
  .steps li::before { content: ""; width: 6px; height: 6px; margin: 6px 0 0 1px; border-radius: 50%; flex: none; border: 1.25px solid var(--subtle); }
  .steps .more { color: var(--subtle); }
  .steps .more::before { visibility: hidden; }
  input.custom, textarea#draft {
    width: 100%; font: inherit; color: var(--fg); background: var(--surface); border: 0; outline: none;
    border-radius: 10px; padding: 8px 10px; resize: none; user-select: text;
  }
  textarea#draft { background: transparent; padding: 6px 2px; min-height: 30px; max-height: 120px; font-size: 14px; }
  textarea#draft::placeholder, input.custom::placeholder { color: var(--subtle); }
  .draft-wrap { position: relative; }
  #voice-preview { position: absolute; inset: 0; padding: 6px 2px; font-size: 14px; white-space: pre-wrap; overflow-wrap: break-word; pointer-events: none; overflow: hidden; }
  #voice-preview .tentative { color: var(--subtle); }
  .composer-top { display: flex; align-items: center; gap: 6px; }
  .target { height: 24px; padding: 0 7px 0 9px; border-radius: 8px; background: var(--surface); font-size: 12px; font-weight: 500;
    max-width: 260px; display: inline-flex; align-items: center; gap: 4px; }
  .target span { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .target svg { width: 10px; height: 10px; flex: none; fill: none; stroke: var(--muted); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
  .target:hover { background: var(--surface-hover); }
  .badge { height: 24px; padding: 0 8px; border-radius: 8px; font-size: 11px; font-weight: 500; display: inline-flex; align-items: center;
    background: rgba(255,255,255,0.14); }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 4px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 4px 0 9px; border-radius: 8px;
    background: var(--surface); font-size: 12px; max-width: 220px; }
  .chip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .chip button { width: 18px; height: 18px; border-radius: 5px; color: var(--muted); font-size: 14px; line-height: 1; }
  .chip button:hover { background: var(--surface-hover); color: var(--fg); }
  .composer-foot { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
  .composer-foot .hint { flex: 1; padding-left: 2px; color: var(--subtle); font-size: 11.5px; }
  .icon-btn { width: 28px; height: 28px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; background: var(--surface); }
  .icon-btn:hover { background: var(--surface-hover); }
  .icon-btn svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .icon-btn.send { background: var(--send); color: #fff; }
  .icon-btn.send:hover { background: #d93f44; }
  .icon-btn.send[disabled] { background: var(--surface); color: var(--subtle); }
  .icon-btn.is-on, .icon-btn.is-on:hover { background: rgba(229,72,77,0.22); color: #ff6b6f; }
  .zones { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 6px; }
  .zone { height: 74px; border-radius: 14px; border: 1.5px dashed rgba(255,255,255,0.22); display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 3px; min-width: 0; padding: 0 10px; text-align: center; color: var(--muted);
    transition: background-color 120ms, border-color 120ms, color 120ms; }
  .zone b, .zone span { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .zone b { color: var(--fg); font-weight: 500; }
  .zone.is-over { background: rgba(255,255,255,0.12); border-style: solid; border-color: rgba(255,255,255,0.35); color: var(--fg); }
  .zone.is-disabled { opacity: 0.35; }
  .zone-hint { color: var(--subtle); font-size: 11.5px; text-align: center; margin-top: 8px; }
</style>
</head>
<body>
<div id="shell" class="is-hidden">
  <div id="clip">
    <div id="panel"><div id="panel-inner"></div></div>
  </div>
  <div id="wings"><div class="wing" id="wing-left"></div><div class="gap"></div><div class="wing" id="wing-right"></div></div>
</div>
<script>
(() => {
  const M = (${islandModelRuntime.toString()})();
  const SHADERS = ${shadersJson};
  const GLYPHS = ${glyphsJson};
  const bridge = window.matterIsland;
  const shell = document.getElementById("shell");
  const panel = document.getElementById("panel");
  const panelInner = document.getElementById("panel-inner");
  const wingLeft = document.getElementById("wing-left");
  const wingRight = document.getElementById("wing-right");
  const gapEl = document.querySelector("#wings .gap");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  let metrics = { hasNotch: true, notchWidth: 200, notchHeight: 32, windowWidth: 520 };
  let snapshot = null;
  let open = false;
  let openReason = null;
  let wantsPrompt = false;
  let needsDeferred = false;
  let dropActive = false;
  let dropZone = null;
  let pointerInside = false;
  let pressed = false;
  let hoverPeek = false;
  let hoverTimer = 0;
  let leaveTimer = 0;
  let deadlineTimer = 0;
  let autoPeek = { seen: [], until: 0 };
  // Request id → when the island answered it; hidden until it clears or the answer times out.
  let answered = new Map();
  let inputGuard = { key: "", since: 0 };
  let notice = "";
  let needsKey = null;
  let glanceIndex = 0;
  let draft = "";
  let dictationHeld = false;
  let lastSyncedDraft = "";
  let draftRevision = -1;
  let files = [];
  let urls = [];
  let target = null;
  let question = { id: null, index: 0, answers: {}, custom: "" };
  let mode = "hidden";
  let lastGeometryKey = "";
  let lastWingKey = { left: "", right: "" };
  let lastPanelKey = "";
  let lastPassthrough = null;

  function esc(value) {
    return String(value == null ? "" : value)
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  }

  function setPassthrough(ignore) {
    if (lastPassthrough === ignore) return;
    lastPassthrough = ignore;
    bridge.setMousePassthrough(ignore);
  }

  function relTime(iso) {
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms) || ms < 60000) return "now";
    if (ms < 3600000) return Math.round(ms / 60000) + "m";
    if (ms < 86400000) return Math.round(ms / 3600000) + "h";
    return Math.round(ms / 86400000) + "d";
  }

  function providerGlyph(kind, name) {
    if (kind && GLYPHS.marks[kind]) return '<span class="glyph">' + GLYPHS.marks[kind] + "</span>";
    const letter = (kind && GLYPHS.monograms[kind]) || String(name || kind || "M").charAt(0).toUpperCase();
    return '<span class="glyph monogram">' + esc(letter) + "</span>";
  }

  const MIC_SVG = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>';
  const SEND_SVG = '<svg viewBox="0 0 24 24"><path d="M12 19V5M6 11l6-6 6 6"/></svg>';
  const CHEVRON_SVG = '<svg viewBox="0 0 12 12"><path d="M4.5 2.5L8 6l-3.5 3.5"/></svg>';
  const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function threadByKey(key) {
    return (snapshot && snapshot.recentThreads.find((t) => t.key === key)) || null;
  }

  // ---- Siri wave (mounted only while listening) ----
  let gl = null, progs = null, glBuf = null, waveCanvas = null, waveRaf = 0, waveStart = 0, waveLast = 0;

  function compile(fragSrc) {
    const make = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const prog = gl.createProgram();
    const vs = make(gl.VERTEX_SHADER, SHADERS.vert);
    const fs = make(gl.FRAGMENT_SHADER, fragSrc);
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    gl.deleteShader(vs); gl.deleteShader(fs);
    return { prog, aPos: gl.getAttribLocation(prog, "aPos"), uRes: gl.getUniformLocation(prog, "iResolution"), uTime: gl.getUniformLocation(prog, "iTime") };
  }

  function destroyWave() {
    if (waveRaf) cancelAnimationFrame(waveRaf);
    waveRaf = 0;
    if (gl) {
      try {
        if (progs) { gl.deleteProgram(progs.wave.prog); gl.deleteProgram(progs.fluidDots.prog); }
        if (glBuf) gl.deleteBuffer(glBuf);
        const lose = gl.getExtension("WEBGL_lose_context");
        if (lose) lose.loseContext();
      } catch {}
    }
    gl = null; progs = null; glBuf = null; waveCanvas = null;
  }

  function waveVisual() {
    const voice = snapshot ? snapshot.voice : null;
    const a = snapshot ? snapshot.assistant : null;
    if (a && (a.phase === "speaking" || a.speaking)) return { variant: "wave", level: Math.max(0.18, a.outputLevel || 0) };
    if (a && (a.phase === "thinking" || a.phase === "acting" || a.phase === "transcribing")) return { variant: "fluidDots", level: 0.4 };
    if (voice && (voice.phase === "preparing" || voice.phase === "transcribing")) return { variant: "fluidDots", level: 0.2 };
    return { variant: "wave", level: Math.max(voice ? voice.level : 0, a ? 0.12 : 0) };
  }

  function mountWave() {
    const canvas = document.getElementById("wave");
    if (!canvas) { destroyWave(); return; }
    if (canvas !== waveCanvas) {
      destroyWave();
      waveCanvas = canvas;
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
      if (!gl) return;
      progs = { wave: compile(SHADERS.wave), fluidDots: compile(SHADERS.fluidDots) };
      glBuf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(56 * dpr);
      canvas.height = Math.round(24 * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
      waveStart = performance.now();
    }
    if (waveRaf || !gl) return;
    const frame = (now) => {
      waveRaf = 0;
      if (!gl || !waveCanvas || !waveCanvas.isConnected) { destroyWave(); return; }
      // SVG-free, but still stepped at ~30 fps: the wave is the only thing moving.
      if (now - waveLast >= 32) {
        waveLast = now;
        const visual = waveVisual();
        const p = visual.variant === "fluidDots" ? progs.fluidDots : progs.wave;
        gl.useProgram(p.prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, glBuf);
        gl.enableVertexAttribArray(p.aPos);
        gl.vertexAttribPointer(p.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(p.uRes, waveCanvas.width, waveCanvas.height);
        gl.uniform1f(p.uTime, reducedMotion.matches ? 1.2 : (now - waveStart) / 1000);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        waveCanvas.style.transform = "scaleY(" + (0.55 + 0.9 * Math.min(1, visual.level)).toFixed(3) + ")";
      }
      if (!reducedMotion.matches) waveRaf = requestAnimationFrame(frame);
    };
    waveRaf = requestAnimationFrame(frame);
  }

  // ---- Wings ----
  function rightWingHtml(w) {
    switch (w.kind) {
      case "listening": return { key: "listening", html: '<canvas id="wave"></canvas>' };
      case "needs-you": return { key: "needs", html: '<span class="amber"><i></i><span class="count">' + w.count + "</span></span>" };
      case "failed": return { key: "failed", html: '<span class="bang">!</span>' };
      case "running-many": return { key: "many:" + w.count, html: '<span class="count">' + w.count + "</span>" };
      case "running": {
        if (w.progress) {
          const r = 6.5, c = 2 * Math.PI * r;
          const done = c * Math.min(1, w.progress.completed / w.progress.total);
          return { key: "ring:" + w.progress.completed + "/" + w.progress.total, html:
            '<span class="ring-wrap"><svg class="ring" viewBox="0 0 16 16"><circle cx="8" cy="8" r="' + r + '" stroke="rgba(255,255,255,0.22)"/>' +
            '<circle cx="8" cy="8" r="' + r + '" stroke="#f5f5f7" stroke-linecap="round" stroke-dasharray="' + done.toFixed(2) + " " + c.toFixed(2) +
            '" transform="rotate(-90 8 8)"/></svg></span>' };
        }
        const lit = w.step % 3;
        return { key: "dots:" + lit, html: '<span class="dots">' + [0, 1, 2].map((i) => "<i" + (i === lit ? ' class="on"' : "") + "></i>").join("") + "</span>" };
      }
      case "done": return { key: "done", html: '<span class="check is-done">' + CHECK_SVG + "</span>" };
      default: return { key: "", html: "" };
    }
  }

  function leftWingHtml(w) {
    if (w.kind === "idle") return { key: "", html: "" };
    if (w.kind === "listening") return { key: "mic", html: '<span class="glyph check">' + MIC_SVG + "</span>" };
    const thread = snapshot && snapshot.recentThreads.find((t) => t.providerKind === w.providerKind);
    return { key: "p:" + (w.providerKind || ""), html: providerGlyph(w.providerKind, thread ? thread.providerName : null) };
  }

  function paintWing(el, slot, next) {
    if (lastWingKey[slot] === next.key) return;
    const swapping = lastWingKey[slot] !== "" && next.key !== "";
    lastWingKey[slot] = next.key;
    el.innerHTML = next.html;
    if (swapping && el.firstElementChild) el.firstElementChild.classList.add("swap-in");
  }

  // ---- Cards ----
  function needsList() { return snapshot ? M.needsYouItems(snapshot, answered) : []; }

  function currentNeeds(list) {
    if (list.length === 0) return null;
    const found = list.findIndex((item) => item.id === needsKey);
    const index = found >= 0 ? found : 0;
    needsKey = list[index].id;
    return { item: list[index], index };
  }

  function rowHtml(opts) {
    return '<div class="row' + (opts.selected ? " is-selected" : "") + '"' + (opts.action ? ' data-action="' + opts.action + '"' : "") +
      (opts.data || "") + ">" + providerGlyph(opts.providerKind, opts.providerName) +
      '<div class="text"><div class="title">' + esc(opts.title) + '</div><div class="detail">' + esc(opts.detail) + "</div></div>" +
      (opts.trailing || "") + "</div>";
  }

  function approvalButtons(approval) {
    const choices = approval.canRespond ? M.inlineApprovalChoices(approval) : null;
    if (!choices) return null;
    const button = (option, label, primary) => '<button class="btn small' + (primary ? " primary" : "") + '" data-action="approve" data-request="' +
      esc(approval.requestId) + '" data-decision="' + option.decision + '">' + label + "</button>";
    return '<div style="display:flex;gap:5px;flex:none">' + button(choices.decline, "Deny", false) + button(choices.accept, "Approve", true) + "</div>";
  }

  function peekHtml() {
    const rows = M.peekRows(snapshot, answered);
    if (rows.length === 0) {
      return '<div class="empty"><b>No agents running.</b> Click to ask or add a task.</div>';
    }
    return rows.map((row) => {
      const thread = threadByKey(row.threadKey);
      const dot = row.kind === "needs-you" ? "needs" : row.kind;
      const trailing = (row.needsYou && row.needsYou.kind === "approval" ? approvalButtons(row.needsYou.item) : null) ||
        '<span class="state-dot ' + dot + '"></span>';
      return rowHtml({ providerKind: row.providerKind, providerName: thread ? thread.providerName : null, title: row.title, detail: row.detail, trailing });
    }).join("");
  }

  // The left wing already shows the first item's provider right above this line; repeat it only when it differs.
  function needsHeader(entry, total, lead) {
    const thread = threadByKey(entry.item.threadKey);
    const glyph = entry.item.providerKind === lead.providerKind ? "" : providerGlyph(entry.item.providerKind, thread ? thread.providerName : null);
    return '<div class="head">' + glyph +
      '<span class="title">' + esc(entry.item.item.threadTitle) + "</span>" +
      (total > 1 ? '<span class="pager">' + (entry.index + 1) + " of " + total + " · ⌘↑↓</span>" : "") + "</div>";
  }

  // Deny-style choices first, the primary last; shortcuts number them left to right.
  function orderedApprovalOptions(approval) {
    return approval.options.filter((o) => o.decision !== "accept").concat(approval.options.filter((o) => o.decision === "accept"));
  }

  function approvalCard(approval) {
    let html = '<div class="card-title">' + esc(approval.title) + "</div>";
    if (approval.detail) html += '<div class="mono">' + esc(approval.detail) + "</div>";
    if (approval.reason) html += '<div class="reason">' + esc(approval.reason) + "</div>";
    if (!approval.canRespond) {
      return html + '<div class="actions"><span class="muted spacer">Answer this one in Matter.</span><button class="btn primary" data-action="open-thread" data-env="' +
        esc(approval.environmentId) + '" data-thread="' + esc(approval.threadId) + '">Open ↗</button></div>';
    }
    html += '<div class="actions"><button class="btn" data-action="later">Later</button><span class="spacer"></span>';
    const ordered = orderedApprovalOptions(approval);
    for (const [i, option] of ordered.entries()) {
      const index = i + 1;
      html += '<button class="btn' + (option.decision === "accept" ? " primary" : "") + '" data-action="approve" data-request="' + esc(approval.requestId) +
        '" data-decision="' + option.decision + '" title="' + esc(option.warning || "") + '">' + esc(option.label) + "<kbd>" + index + "</kbd></button>";
    }
    return html + "</div>";
  }

  function questionState(input) {
    if (question.id !== input.requestId) question = { id: input.requestId, index: 0, answers: {}, custom: "" };
    return question;
  }

  function hasAnswer(state, q) {
    const picked = state.answers[q.id];
    return (Array.isArray(picked) ? picked.length > 0 : picked !== undefined) || state.custom.trim().length > 0;
  }

  function questionCard(input) {
    const state = questionState(input);
    const q = input.questions[state.index] || input.questions[0];
    if (!q) return "";
    const picked = state.answers[q.id];
    const pickedSet = new Set(Array.isArray(picked) ? picked : picked ? [picked] : []);
    let html = '<div class="card-title">' + esc(q.header || "Question") + (input.questions.length > 1 ? ' <span class="muted">' + (state.index + 1) + "/" + input.questions.length + "</span>" : "") + "</div>";
    html += '<div class="question-text" title="' + esc(q.question) + '">' + esc(q.question) + "</div>";
    html += '<div class="options">' + q.options.map((option, i) =>
      '<button class="option' + (pickedSet.has(option.value) ? " is-picked" : "") + '" data-action="pick-option" data-value="' + esc(option.value) + '">' +
      '<span class="letter">' + String.fromCharCode(65 + i) + "</span><span><div>" + esc(option.label) + "</div>" +
      (option.description ? '<div class="desc">' + esc(option.description) + "</div>" : "") + "</span></button>").join("") + "</div>";
    if (q.allowCustomAnswer) html += '<input class="custom" id="custom-answer" placeholder="Something else…" style="margin-top:6px" value="' + esc(state.custom) + '" />';
    const last = state.index >= input.questions.length - 1;
    html += '<div class="actions">' + (input.dismissible ? '<button class="btn" data-action="skip-question">Skip</button>' : '<button class="btn" data-action="later">Later</button>') +
      '<span class="spacer"></span><button class="btn primary" data-action="submit-question"' + (hasAnswer(state, q) ? "" : " disabled") + ">" + (last ? "Submit" : "Next") + "<kbd>↵</kbd></button></div>";
    return html;
  }

  function planCard(plan) {
    let html = '<div class="card-title">' + esc(plan.title || "Plan ready") + "</div>";
    if (plan.steps.length > 0) {
      html += '<ul class="steps">' + plan.steps.map((step) => "<li>" + esc(step) + "</li>").join("") +
        (plan.stepCount > plan.steps.length ? '<li class="more">+' + (plan.stepCount - plan.steps.length) + " more</li>" : "") + "</ul>";
    }
    const data = ' data-env="' + esc(plan.environmentId) + '" data-thread="' + esc(plan.threadId) + '"';
    return html + '<div class="actions"><button class="btn" data-action="open-thread"' + data + '>Open ↗</button><span class="spacer"></span>' +
      '<button class="btn" data-action="revise"' + data + ">Revise…</button>" +
      (plan.canApprove ? '<button class="btn primary" data-action="approve-plan" data-plan="' + esc(plan.planId) + '"' + data + ">Approve<kbd>↵</kbd></button>" : "") + "</div>";
  }

  function needsCard() {
    const list = needsList();
    const entry = currentNeeds(list);
    if (!entry) return { key: "needs:none", html: "" };
    const body = entry.item.kind === "approval" ? approvalCard(entry.item.item)
      : entry.item.kind === "question" ? questionCard(entry.item.item) : planCard(entry.item.item);
    // The custom answer stays out of the key: typing it must never rebuild the card under the caret.
    const questionKey = entry.item.kind === "question" ? JSON.stringify({ index: question.index, answers: question.answers }) : "";
    return { key: "needs:" + entry.item.id + ":" + list.length + ":" + questionKey, html: needsHeader(entry, list.length, list[0]) + body,
      item: entry.item.id + ":" + (entry.item.kind === "question" ? question.index : "") };
  }

  function targetLabel(t) {
    if (!t) return "No target";
    if (t.kind === "new-thread") return "New thread";
    if (t.kind === "task") return "Task";
    return M.threadTitle(snapshot, t.environmentId + ":" + t.threadId) || "Thread";
  }

  function ensureTarget() {
    target = M.reconcileTarget(snapshot, target);
    return M.captureTargets(snapshot);
  }

  function hasLocalPaths() {
    return files.length > 0 || urls.some((u) => /^file:/i.test(u));
  }

  const REMOTE_PATHS_NOTICE = "Local files can't go to a thread on another computer.";

  function promptCard() {
    ensureTarget();
    const parsed = M.parseCapturePrefix(draft);
    const listening = M.isListening(snapshot) && snapshot.voice.phase !== "idle";
    const chips = files.map((f, i) => '<span class="chip"><span>' + esc(f.name) + '</span><button data-action="remove-file" data-index="' + i + '">×</button></span>')
      .concat(urls.map((u, i) => '<span class="chip"><span>' + esc(u) + '</span><button data-action="remove-url" data-index="' + i + '">×</button></span>')).join("");
    const canSend = Boolean(target) && (parsed.text.length > 0 || files.length > 0 || urls.length > 0);
    const html =
      '<div class="composer-top"><button class="target" data-action="cycle-target" title="Tab to change"><span>' + esc(targetLabel(target)) + "</span>" + CHEVRON_SVG + "</button>" +
      (parsed.interactionMode !== "default" ? '<span class="badge">' + (parsed.interactionMode === "plan" ? "Plan" : "Goal") + "</span>" : "") + "</div>" +
      '<div class="draft-wrap"><textarea id="draft" rows="1" placeholder="' + (listening ? "Listening…" : "Ask, steer or add a task…") + '"></textarea>' +
      (listening ? '<div id="voice-preview" aria-live="polite"></div>' : "") + "</div>" +
      (chips ? '<div class="chips">' + chips + "</div>" : "") +
      (notice ? '<div class="reason">' + esc(notice) + "</div>" : "") +
      '<div class="composer-foot"><span class="hint">Tab target · ' + (dictationHeld ? "release ⌃ to stop" : "⌃ hold to dictate") + " · ↵ send</span>" +
      '<button class="icon-btn' + (listening ? " is-on" : "") + '" data-action="mic" title="Dictate">' + MIC_SVG + "</button>" +
      '<button class="icon-btn send" data-action="send" title="Send"' + (canSend ? "" : " disabled") + ">" + SEND_SVG + "</button></div>";
    return { key: "prompt:" + targetLabel(target) + ":" + parsed.interactionMode + ":" + chips + ":" + listening + ":" + canSend + ":" + notice + ":" + dictationHeld, html, prompt: true };
  }

  function glanceStatus(thread) {
    const tone = thread.status === "running" ? "running" : thread.status === "approval" || thread.status === "input" ? "needs"
      : thread.status === "failed" ? "failed" : null;
    const age = '<span class="meta' + (tone === "running" ? " running" : "") + '">' + relTime(thread.updatedAt) + "</span>";
    return '<span class="status">' + (tone ? '<span class="state-dot ' + tone + '"></span>' : "") + age + "</span>";
  }

  function glanceCard() {
    const threads = M.glanceThreads(snapshot);
    glanceIndex = Math.min(glanceIndex, Math.max(0, threads.length - 1));
    const rows = threads.map((thread, i) => {
      const detail = thread.status === "running" ? (thread.currentActivity ? thread.currentActivity.label : "Working")
        : thread.status === "approval" || thread.status === "input" ? "Needs you"
        : thread.status === "failed" ? "Failed" : thread.status === "limited" ? "Usage limit"
        : thread.status === "done" ? "Done" : thread.projectTitle || "Idle";
      return rowHtml({ providerKind: thread.providerKind, providerName: thread.providerName, title: thread.title, detail, selected: i === glanceIndex,
        action: "open-thread", data: ' data-env="' + esc(thread.environmentId) + '" data-thread="' + esc(thread.threadId) + '"',
        trailing: glanceStatus(thread) });
    }).join("");
    const html = rows + '<div class="actions"><button class="btn" data-action="voice-mode">Voice Mode</button><span class="spacer"></span>' +
      '<button class="btn primary" data-action="ask">Ask…<kbd class="sym">⌃⌃</kbd></button></div>';
    return { key: "glance:" + threads.map((t) => t.key + t.status + relTime(t.updatedAt) + (t.currentActivity ? t.currentActivity.label : "")).join("|") + ":" + glanceIndex, html };
  }

  function dropCard() {
    const threadTarget = M.captureTargets(snapshot).find((t) => t.kind === "thread");
    const threadTitle = threadTarget ? (threadByKey(threadTarget.environmentId + ":" + threadTarget.threadId) || {}).title : null;
    const zone = (id, label, sub, enabled) =>
      '<div class="zone' + (dropZone === id ? " is-over" : "") + (enabled ? "" : " is-disabled") + '" data-zone="' + id + '"><b>' + esc(label) + "</b><span>" + esc(sub) + "</span></div>";
    const html = '<div class="zones">' +
      zone("thread", "This thread", threadTitle ? "→ " + threadTitle : "None open", Boolean(threadTarget)) +
      zone("new-thread", "New thread", "Start with it", Boolean(snapshot && snapshot.canStartThread)) +
      zone("task", "New task", "Save for later", Boolean(snapshot && snapshot.canCreateTask)) +
      '</div><div class="zone-hint">Drop to attach, then add a note before sending.</div>';
    return { key: "drop:" + dropZone + ":" + threadTitle, html };
  }

  function openCardKind() {
    const needsCount = needsDeferred ? 0 : needsList().length;
    return M.chooseOpenCard({
      dropActive,
      needsYouCount: needsCount,
      hasDraft: draft.trim().length > 0 || files.length > 0 || urls.length > 0,
      wantsPrompt: wantsPrompt || openReason === "shortcut" || (snapshot ? snapshot.voice.phase !== "idle" : false),
      glanceCount: snapshot ? M.glanceThreads(snapshot).length : 0,
    });
  }

  function buildPanel() {
    if (!snapshot) return { key: "none", html: "" };
    if (mode === "peek") {
      const html = peekHtml();
      return { key: "peek:" + html, html, item: M.peekRows(snapshot, answered).map((row) => (row.needsYou ? row.needsYou.id : "")).join(",") };
    }
    if (mode !== "open") return { key: "none", html: "" };
    const kind = openCardKind();
    if (kind === "drop") return dropCard();
    if (kind === "needs-you") return needsCard();
    if (kind === "prompt") return promptCard();
    return glanceCard();
  }

  function paintPanel() {
    const next = buildPanel();
    inputGuard = M.stepInputGuard(inputGuard, next.item || "", Date.now());
    if (next.key === lastPanelKey) return;
    const wasEmpty = lastPanelKey === "" || lastPanelKey === "none";
    const sameCard = lastPanelKey.split(":")[0] === next.key.split(":")[0];
    lastPanelKey = next.key;
    const active = document.activeElement;
    const focusedId = active && (active.id === "draft" || active.id === "custom-answer") ? active.id : null;
    const selection = focusedId ? [active.selectionStart, active.selectionEnd] : null;
    const old = panelInner.querySelector(".card");
    if (old && !sameCard && !wasEmpty) {
      old.classList.remove("content-in");
      old.classList.add("content-out");
      old.addEventListener("animationend", () => old.remove(), { once: true });
      if (reducedMotion.matches) old.remove();
    } else if (old) {
      old.remove();
    }
    for (const stale of panelInner.querySelectorAll(".content-out")) if (stale !== old) stale.remove();
    if (!next.html) return;
    const card = document.createElement("div");
    card.className = "card" + (sameCard && !wasEmpty ? "" : " content-in");
    card.innerHTML = next.html;
    panelInner.appendChild(card);
    const textarea = card.querySelector("#draft");
    if (textarea) {
      textarea.value = draft;
      autosize(textarea);
      if (open) {
        textarea.focus();
        if (focusedId === "draft") textarea.setSelectionRange(selection[0], selection[1]);
        else textarea.setSelectionRange(draft.length, draft.length);
      }
    }
    const options = card.querySelector(".options");
    if (options) fitOptions(options);
    const custom = card.querySelector("#custom-answer");
    if (custom && open && focusedId === "custom-answer") {
      custom.focus();
      custom.setSelectionRange(selection[0], selection[1]);
    }
  }

  // The live words sit after the draft inside the field: the draft prefix is invisible and only lays them out.
  function paintVoicePreview(preview) {
    const committed = snapshot.voice.previewCommitted.trim();
    const tentative = snapshot.voice.previewTentative.trim();
    const textarea = document.getElementById("draft");
    if (textarea) textarea.placeholder = committed || tentative ? "" : "Listening…";
    const prefix = draft ? '<span style="color:transparent">' + esc(draft) + (/\\s$/.test(draft) ? "" : " ") + "</span>" : "";
    preview.innerHTML = prefix + esc(committed) + (committed && tentative ? " " : "") + '<span class="tentative">' + esc(tentative) + "</span>";
  }

  // A long list shows whole rows plus 40% of the next one, faded out, so it reads as scrollable.
  function fitOptions(options) {
    const limit = 272;
    if (options.scrollHeight > limit) {
      const next = [...options.children].find((o) => o.offsetTop - options.offsetTop + o.offsetHeight > limit);
      if (next) options.style.maxHeight = Math.round(next.offsetTop - options.offsetTop + next.offsetHeight * 0.4) + "px";
    }
    markOptionsOverflow(options);
  }

  // Fades the list's bottom edge while more options sit below it.
  function markOptionsOverflow(options) {
    options.classList.toggle("has-more", options.scrollTop + options.clientHeight < options.scrollHeight - 2);
  }

  function autosize(textarea) {
    textarea.style.height = "auto";
    textarea.style.height = Math.min(120, textarea.scrollHeight) + "px";
  }

  // ---- Geometry ----
  function contentHeight() {
    const live = panelInner.querySelector(".card:not(.content-out)");
    return live ? Math.ceil(panelInner.offsetHeight) : 0;
  }

  let previousMode = "hidden";
  let previousWingWidth = 36;

  function springFor(from, to, wingWidthChanged) {
    if (to === "open") return from === "open" ? "morph" : "expand";
    if (to === "peek") return from === "open" ? "collapse" : from === "peek" ? "morph" : "peek";
    if (to === "collapsed") return from === "hidden" ? "notification" : from === "collapsed" ? (wingWidthChanged ? "pop" : "settle") : "collapse";
    return "collapse";
  }

  function applyGeometry(wing) {
    const g = M.shellGeometry(mode, wing, metrics, mode === "peek" || mode === "open" ? contentHeight() : 0);
    const key = [mode, g.width, g.height, g.ear, g.bottomRadius, g.pill, wing.wingWidth].join(",");
    const root = document.documentElement.style;
    root.setProperty("--notch-w", metrics.notchWidth + "px");
    root.setProperty("--notch-h", metrics.notchHeight + "px");
    root.setProperty("--content-w", (mode === "peek" ? 360 : 420) + "px");
    placeWings(g, wing);
    if (key === lastGeometryKey) return;
    lastGeometryKey = key;
    const spring = springFor(previousMode, mode, previousWingWidth !== wing.wingWidth);
    shell.style.setProperty("--shell-ease", "var(--island-ease-" + spring + ")");
    shell.style.setProperty("--shell-dur", "var(--island-dur-" + spring + ")");
    root.setProperty("--wing-w", wing.wingWidth + "px");
    shell.style.width = g.width + "px";
    shell.style.height = g.height + "px";
    shell.style.setProperty("--ear", g.ear + "px");
    shell.style.setProperty("--br", Math.min(g.bottomRadius, g.pill ? g.height / 2 : g.bottomRadius) + "px");
    shell.classList.toggle("pill", g.pill);
    shell.classList.toggle("is-hidden", mode === "hidden");
    previousMode = mode;
    previousWingWidth = wing.wingWidth;
    if (mode === "hidden" && (reducedMotion.matches || !metrics.hasNotch)) scheduleIdleNotice();
  }

  // Expanded, the wing icons ride the shell's spring out to the card's content edges, like the
  // expanded Dynamic Island; collapsed, they sit beside the camera. Pill screens close the gap.
  const WING_INSET = { peek: 22, glance: 22, needs: 16 };
  function placeWings(g, wing) {
    const expanded = mode === "peek" || mode === "open";
    const gapW = g.pill && expanded ? 0 : metrics.notchWidth;
    gapEl.style.width = gapW + "px";
    const inset = WING_INSET[lastPanelKey.split(":")[0]] || 14;
    for (const [el, side] of [[wingLeft, -1], [wingRight, 1]]) {
      const child = el.firstElementChild;
      const shift = expanded && child ? side * (g.width / 2 - inset - gapW / 2 - wing.wingWidth / 2 - child.offsetWidth / 2) : 0;
      el.style.transform = shift ? "translateX(" + shift.toFixed(1) + "px)" : "";
    }
  }

  let idleNoticeTimer = 0;
  function scheduleIdleNotice() {
    clearTimeout(idleNoticeTimer);
    const wait = reducedMotion.matches ? 0 : 400;
    idleNoticeTimer = setTimeout(() => { if (mode === "hidden" && bridge.notifyAnimationIdle) bridge.notifyAnimationIdle(); }, wait);
  }

  function applyBloom() {
    const bloom = pointerInside && (mode === "collapsed" || mode === "hidden") && !open;
    const sx = pressed ? ${t.press} : bloom ? ${t.hoverBloom.x} : 1;
    const sy = pressed ? ${t.press} : bloom ? ${t.hoverBloom.y} : 1;
    shell.style.setProperty("--sx", String(sx));
    shell.style.setProperty("--sy", String(sy));
    shell.classList.toggle("is-pressed", pressed);
  }

  // ---- Render ----
  function scheduleDeadline(wing) {
    clearTimeout(deadlineTimer);
    const now = Date.now();
    const expiries = [...answered.values()].map((at) => at + M.ANSWER_TIMEOUT_MS);
    const deadlines = [autoPeek.until, wing.expiresAt, ...expiries].filter((value) => typeof value === "number" && value > now);
    if (deadlines.length === 0) return;
    deadlineTimer = setTimeout(render, Math.min(...deadlines) - now + 16);
  }

  function render() {
    if (!snapshot) return;
    const now = Date.now();
    answered = M.pruneAnswered(answered, new Set(M.needsYouItems(snapshot).map((item) => item.id)), now);
    const wing = M.deriveWing(snapshot, now, answered);
    const autoPeeking = M.isAutoPeeking(autoPeek, now);
    mode = snapshot.settings.enabled
      ? M.resolveMode({ open, dropActive, hoverPeek, autoPeeking, wingKind: wing.kind })
      : "hidden";
    // Hovering the bare notch still peeks, so the island stays one gesture away when idle.
    paintWing(wingLeft, "left", mode === "hidden" ? { key: "", html: "" } : leftWingHtml(wing));
    paintWing(wingRight, "right", mode === "hidden" ? { key: "", html: "" } : rightWingHtml(wing));
    if (wing.kind === "listening" && mode !== "hidden") mountWave(); else destroyWave();
    paintPanel();
    const preview = document.getElementById("voice-preview");
    if (preview) paintVoicePreview(preview);
    applyGeometry(wing);
    applyBloom();
    scheduleDeadline(wing);
  }

  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { if (mode === "peek" || mode === "open") { lastGeometryKey = ""; render(); } }).observe(panelInner);
  }

  // ---- Open / close ----
  function openIsland(reason) {
    // The target is fixed when the island opens, so a busy thread can't take over the draft.
    if (!open && snapshot) target = M.reconcileTarget(snapshot, null);
    open = true;
    openReason = reason;
    hoverPeek = false;
    autoPeek = { seen: autoPeek.seen, until: 0 };
    if (reason !== "drop") bridge.focusWindow();
    render();
  }

  function closeIsland() {
    flushDraft();
    const wasOpen = open;
    open = false;
    openReason = null;
    wantsPrompt = false;
    dictationHeld = false;
    needsDeferred = false;
    dropActive = false;
    dropZone = null;
    hoverPeek = false;
    notice = "";
    if (snapshot && snapshot.voice.phase === "recording") bridge.sendAction({ type: "voice-stop" });
    if (wasOpen) bridge.releaseFocus();
    // Main made the window click-through; the next pointer move re-sends what the pointer is over.
    lastPassthrough = null;
    render();
  }

  let draftTimer = 0;
  function flushDraft() {
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (draft === lastSyncedDraft) return;
    lastSyncedDraft = draft;
    bridge.sendAction({ type: "update-draft", text: draft });
  }

  // Keystrokes reach main at most every 150 ms; submit, close, target and dictation changes flush first.
  function syncDraft(text, immediate) {
    draft = text;
    clearTimeout(draftTimer);
    draftTimer = 0;
    if (immediate) flushDraft();
    else if (text !== lastSyncedDraft) draftTimer = setTimeout(flushDraft, 150);
  }

  function submitCapture() {
    ensureTarget();
    const parsed = M.parseCapturePrefix(draft);
    if (!target || (!parsed.text && files.length === 0 && urls.length === 0)) return;
    if (hasLocalPaths() && !M.capturePathsAllowed(snapshot, target)) { notice = REMOTE_PATHS_NOTICE; render(); return; }
    notice = "";
    bridge.sendAction({ type: "submit-capture", target, text: parsed.text, interactionMode: parsed.interactionMode, files, urls });
    files = [];
    urls = [];
    syncDraft("", true);
    closeIsland();
  }

  function respondApproval(requestId, decision) {
    const approval = snapshot.pendingApprovals.find((item) => item.requestId === requestId);
    if (!approval) return;
    answered.set(requestId, Date.now());
    bridge.sendAction({ type: "respond-approval", environmentId: approval.environmentId, threadId: approval.threadId, requestId, decision });
    if (!open) {
      // A click in Peek can key the panel; hand the keyboard straight back.
      bridge.releaseFocus();
      lastPassthrough = null;
    }
    render();
  }

  function inputBlocked() { return M.isInputGuarded(inputGuard, Date.now()); }

  function currentQuestionInput() {
    const entry = currentNeeds(needsList());
    return entry && entry.item.kind === "question" ? entry.item.item : null;
  }

  function pickOption(value) {
    const input = currentQuestionInput();
    if (!input) return;
    const state = questionState(input);
    const q = input.questions[state.index];
    if (!q) return;
    if (q.multiSelect) {
      const current = Array.isArray(state.answers[q.id]) ? state.answers[q.id] : [];
      state.answers[q.id] = current.includes(value) ? current.filter((v) => v !== value) : current.concat([value]);
    } else {
      state.answers[q.id] = value;
      state.custom = "";
    }
    render();
  }

  function submitQuestion() {
    const input = currentQuestionInput();
    if (!input) return;
    const state = questionState(input);
    const q = input.questions[state.index];
    if (q && state.custom.trim()) state.answers[q.id] = q.multiSelect ? [state.custom.trim()] : state.custom.trim();
    if (q && !hasAnswer(state, q)) return;
    if (state.index < input.questions.length - 1) {
      state.index += 1;
      state.custom = "";
      render();
      return;
    }
    answered.set(input.requestId, Date.now());
    bridge.sendAction({ type: "respond-user-input", environmentId: input.environmentId, threadId: input.threadId, requestId: input.requestId, answers: state.answers });
    render();
  }

  function stepNeeds(delta) {
    const list = needsList();
    const entry = currentNeeds(list);
    if (!entry || list.length < 2) return;
    needsKey = list[(entry.index + delta + list.length) % list.length].id;
    render();
  }

  document.addEventListener("click", (event) => {
    const el = event.target.closest("[data-action]");
    const insideShell = event.target.closest("#shell");
    if (!el) {
      if (!insideShell) { if (open) closeIsland(); return; }
      if (!open) openIsland("click");
      return;
    }
    const d = el.dataset;
    const answers = d.action === "approve" || d.action === "approve-plan" || d.action === "pick-option" || d.action === "submit-question" || d.action === "skip-question";
    if (answers && inputBlocked()) { event.stopPropagation(); return; }
    switch (d.action) {
      case "approve": event.stopPropagation(); respondApproval(d.request, d.decision); return;
      case "open-thread":
        bridge.sendAction({ type: "open-thread", environmentId: d.env, threadId: d.thread });
        closeIsland();
        return;
      case "approve-plan":
        answered.set(d.plan, Date.now());
        bridge.sendAction({ type: "approve-plan", environmentId: d.env, threadId: d.thread, planId: d.plan });
        render();
        return;
      case "revise":
        target = { kind: "thread", environmentId: d.env, threadId: d.thread };
        needsDeferred = true;
        wantsPrompt = true;
        render();
        return;
      case "later": needsDeferred = true; render(); return;
      case "pick-option": pickOption(d.value); return;
      case "submit-question": submitQuestion(); return;
      case "skip-question": {
        const input = currentQuestionInput();
        if (!input) return;
        answered.set(input.requestId, Date.now());
        bridge.sendAction({ type: "dismiss-user-input", environmentId: input.environmentId, threadId: input.threadId, requestId: input.requestId });
        render();
        return;
      }
      case "cycle-target": flushDraft(); target = M.nextTarget(ensureTarget(), target); render(); return;
      case "remove-file": files = files.filter((_, i) => i !== Number(d.index)); render(); return;
      case "remove-url": urls = urls.filter((_, i) => i !== Number(d.index)); render(); return;
      case "mic": toggleDictation(); return;
      case "send": submitCapture(); return;
      case "ask": wantsPrompt = true; render(); return;
      case "voice-mode":
        bridge.sendAction({ type: "assistant-open-voice-mode-modal" });
        closeIsland();
        return;
    }
  });

  function toggleDictation() {
    if (!snapshot) return;
    if (!snapshot.voice.available) { bridge.sendAction({ type: "open-voice-settings" }); closeIsland(); return; }
    syncDraft(draft, true);
    bridge.sendAction({ type: snapshot.voice.phase === "recording" ? "voice-stop" : "voice-start" });
  }

  document.addEventListener("input", (event) => {
    if (event.target.id === "draft") {
      syncDraft(event.target.value);
      autosize(event.target);
      // The card only rebuilds when the send state or the /plan · /goal badge changes.
      render();
    } else if (event.target.id === "custom-answer") {
      question.custom = event.target.value;
      const input = currentQuestionInput();
      const q = input ? input.questions[questionState(input).index] : null;
      const submit = panelInner.querySelector('.card:not(.content-out) [data-action="submit-question"]');
      if (submit && q) submit.disabled = !hasAnswer(question, q);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (!open) return;
    const typing = event.target && (event.target.tagName === "TEXTAREA" || event.target.tagName === "INPUT");
    if (event.key === "Escape") { event.preventDefault(); closeIsland(); return; }
    const kind = lastPanelKey.split(":")[0];
    if (kind === "prompt") {
      if (event.key === "Tab") { event.preventDefault(); flushDraft(); target = M.nextTarget(ensureTarget(), target); render(); return; }
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!event.repeat) submitCapture(); }
      return;
    }
    if (kind === "needs") {
      // Held keys and presses right after the request changed never answer the next one.
      if (event.repeat || inputBlocked()) return;
      if (event.metaKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) { event.preventDefault(); stepNeeds(event.key === "ArrowDown" ? 1 : -1); return; }
      const entry = currentNeeds(needsList());
      if (!entry) return;
      if (entry.item.kind === "approval") {
        const approval = entry.item.item;
        const digit = Number.parseInt(event.key, 10);
        const ordered = orderedApprovalOptions(approval);
        if (approval.canRespond && digit >= 1 && digit <= ordered.length) { event.preventDefault(); respondApproval(approval.requestId, ordered[digit - 1].decision); return; }
        if (approval.canRespond && event.key === "Enter") {
          const accept = approval.options.find((o) => o.decision === "accept");
          if (accept) { event.preventDefault(); respondApproval(approval.requestId, accept.decision); }
        }
        return;
      }
      if (entry.item.kind === "question") {
        if (event.key === "Enter") { event.preventDefault(); submitQuestion(); return; }
        if (!typing && event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
          const index = event.key.toUpperCase().charCodeAt(0) - 65;
          const q = entry.item.item.questions[questionState(entry.item.item).index];
          if (q && index >= 0 && index < q.options.length) { event.preventDefault(); pickOption(q.options[index].value); }
        }
        return;
      }
      if (entry.item.kind === "plan" && event.key === "Enter" && entry.item.item.canApprove) {
        event.preventDefault();
        const plan = entry.item.item;
        answered.set(plan.planId, Date.now());
        bridge.sendAction({ type: "approve-plan", environmentId: plan.environmentId, threadId: plan.threadId, planId: plan.planId });
        render();
      }
      return;
    }
    if (kind === "glance") {
      const threads = M.glanceThreads(snapshot);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        glanceIndex = (glanceIndex + (event.key === "ArrowDown" ? 1 : -1) + threads.length) % Math.max(1, threads.length);
        render();
        return;
      }
      if (event.key === "Enter" && threads[glanceIndex]) {
        event.preventDefault();
        bridge.sendAction({ type: "open-thread", environmentId: threads[glanceIndex].environmentId, threadId: threads[glanceIndex].threadId });
        closeIsland();
        return;
      }
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        wantsPrompt = true;
        syncDraft(draft + event.key);
        render();
      }
    }
  });

  document.addEventListener("scroll", (event) => {
    if (event.target.classList && event.target.classList.contains("options")) markOptionsOverflow(event.target);
  }, true);

  // ---- Hover, press, passthrough ----
  function shellContains(x, y) {
    if (!snapshot || !snapshot.settings.enabled) return false;
    if (mode === "hidden") {
      if (!metrics.hasNotch) return false;
      const half = metrics.notchWidth / 2;
      const cx = window.innerWidth / 2;
      return x >= cx - half && x <= cx + half && y >= 0 && y <= metrics.notchHeight;
    }
    const rect = shell.getBoundingClientRect();
    const ear = mode === "collapsed" ? 8 : 18;
    return x >= rect.left - ear && x <= rect.right + ear && y >= rect.top && y <= rect.bottom;
  }

  function onEnter() {
    clearTimeout(leaveTimer);
    if (open) return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => { if (pointerInside && !open) { hoverPeek = true; render(); } }, M.HOVER_DWELL_MS);
    applyBloom();
  }

  function onLeave() {
    clearTimeout(hoverTimer);
    pressed = false;
    applyBloom();
    clearTimeout(leaveTimer);
    leaveTimer = setTimeout(() => { if (!pointerInside && hoverPeek) { hoverPeek = false; render(); } }, 120);
  }

  window.addEventListener("pointermove", (event) => {
    const inside = open || dropActive || shellContains(event.clientX, event.clientY);
    setPassthrough(!inside);
    if (inside === pointerInside) return;
    pointerInside = inside;
    if (inside) onEnter(); else onLeave();
  });
  document.addEventListener("mouseleave", () => {
    if (open || dropActive) return;
    pointerInside = false;
    setPassthrough(true);
    onLeave();
  });
  shell.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || open || event.target.closest("[data-action]")) return;
    pressed = true;
    applyBloom();
  });
  window.addEventListener("pointerup", () => { if (pressed) { pressed = false; applyBloom(); } });
  shell.addEventListener("contextmenu", (event) => { event.preventDefault(); bridge.showContextMenu(); });
  window.addEventListener("blur", () => { if (open && !dropActive) closeIsland(); });

  // ---- Drop ----
  function looksLikeUrl(text) { return /^https?:\\/\\/\\S+$/i.test(text.trim()); }

  function zoneAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const zone = el && el.closest ? el.closest(".zone") : null;
    return zone && !zone.classList.contains("is-disabled") ? zone.dataset.zone : null;
  }

  window.addEventListener("dragenter", (event) => { event.preventDefault(); if (!dropActive) { dropActive = true; render(); } });
  window.addEventListener("dragleave", (event) => {
    // Only a leave out of the window itself; leaves between child elements keep the zones up.
    const out = event.clientX <= 0 || event.clientY <= 0 || event.clientX >= window.innerWidth || event.clientY >= window.innerHeight;
    if (out && dropActive) { dropActive = false; dropZone = null; render(); }
  });
  window.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    const zone = zoneAt(event.clientX, event.clientY);
    if (zone !== dropZone) { dropZone = zone; render(); }
  });
  window.addEventListener("drop", (event) => {
    event.preventDefault();
    const zone = zoneAt(event.clientX, event.clientY);
    const data = event.dataTransfer;
    if (!zone || !data) { dropActive = false; dropZone = null; render(); return; }
    const targets = M.captureTargets(snapshot);
    target = zone === "thread" ? targets.find((t) => t.kind === "thread") || target : { kind: zone };
    const pathsAllowed = M.capturePathsAllowed(snapshot, target);
    let refused = false;
    for (const file of data.files) {
      const path = bridge.getPathForFile(file);
      if (!path || M.hasControlCharacters(path)) continue;
      if (!pathsAllowed) { refused = true; continue; }
      files.push({ name: M.stripControlCharacters(file.name || path.split("/").pop() || "") || "file", path });
    }
    if (data.files.length === 0) {
      const list = M.acceptedDropLinks(data.getData("text/uri-list") || "");
      const plain = data.getData("text/plain") || "";
      for (const link of list.length ? list : looksLikeUrl(plain) ? [plain.trim()] : []) {
        if (/^file:/i.test(link) && !pathsAllowed) { refused = true; continue; }
        if (!urls.includes(link)) urls.push(link);
      }
      if (!list.length && plain && !looksLikeUrl(plain)) syncDraft((draft ? draft + "\\n" : "") + plain);
    }
    notice = refused ? REMOTE_PATHS_NOTICE : "";
    dropActive = false;
    dropZone = null;
    open = true;
    openReason = "drop";
    wantsPrompt = true;
    bridge.focusWindow();
    render();
  });

  // ---- Bridge ----
  bridge.onDisplayMetrics((next) => {
    metrics = {
      hasNotch: Boolean(next.hasNotch),
      notchWidth: Number(next.notchWidth) || 200,
      notchHeight: Number(next.notchHeight) || 32,
      windowWidth: Number(next.windowWidth) || 520,
    };
    lastGeometryKey = "";
    render();
  });

  bridge.onSnapshot((next) => {
    snapshot = next;
    // Adopt the host's draft only when dictation wrote it; keystrokes stay the island's own.
    if (next.voice.draftRevision !== draftRevision) {
      draftRevision = next.voice.draftRevision;
      clearTimeout(draftTimer);
      draftTimer = 0;
      draft = next.voice.draftText;
      lastSyncedDraft = draft;
      const textarea = document.getElementById("draft");
      if (textarea && textarea.value !== draft) { textarea.value = draft; autosize(textarea); }
    }
    const ids = M.needsYouItems(next).map((item) => item.id);
    autoPeek = M.stepAutoPeek(autoPeek, ids, Date.now(), !open && next.settings.showNotifications && !next.mainWindowFocused);
    render();
  });

  bridge.onCommand((command) => {
    if (command.type === "close-panel") { closeIsland(); return; }
    if (command.type === "open") {
      if (open && command.reason === "shortcut") { closeIsland(); return; }
      wantsPrompt = command.reason === "shortcut";
      openIsland(command.reason);
      return;
    }
    if (command.type === "dictation-hold") {
      if (!open) return;
      wantsPrompt = true;
      dictationHeld = command.phase === "start";
      if (command.phase === "start") { syncDraft(draft, true); bridge.sendAction({ type: "voice-start" }); }
      else bridge.sendAction({ type: command.phase === "end" ? "voice-stop" : "voice-cancel" });
      render();
      return;
    }
    if (command.type === "drag") {
      lastPassthrough = null;
      if (command.phase === "near") { if (!dropActive) { dropActive = true; render(); } return; }
      if (dropActive) { dropActive = false; dropZone = null; render(); }
    }
  });

  render();
})();
</script>
</body>
</html>`;
}
