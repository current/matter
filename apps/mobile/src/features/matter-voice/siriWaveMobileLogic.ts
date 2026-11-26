import {
  SIRI_WAVE_SHADERS,
  SIRI_WAVE_VARIANT_BY_STATE,
  SIRI_WAVE_VERT,
  type SiriWaveVariant,
  type SiriWaveVisualState,
} from "../../../../../antimatter/island/siriWaveShaders";

export type SiriWaveMobileMode =
  | "idle"
  | "listening"
  | "hearing"
  | "thinking"
  | "speaking"
  | "muted"
  | "error";

const STATE_BY_MODE: Record<SiriWaveMobileMode, SiriWaveVisualState> = {
  idle: "idle",
  listening: "listening",
  hearing: "listening",
  thinking: "thinking",
  speaking: "speaking",
  muted: "idle",
  error: "error",
};

export function siriWaveStateForMode(mode: SiriWaveMobileMode): SiriWaveVisualState {
  return STATE_BY_MODE[mode];
}

/** What the page needs to draw; sent whenever it changes, never per audio frame. */
export interface SiriWavePageState {
  readonly variant: SiriWaveVariant;
  /** Stops the animation loop and leaves the last frame up, so an idle wave costs no GPU. */
  readonly paused: boolean;
  readonly reducedMotion: boolean;
  readonly opacity: number;
  readonly error: boolean;
}

export function siriWavePageState(input: {
  readonly mode: SiriWaveMobileMode;
  readonly active: boolean;
  readonly reducedMotion: boolean;
}): SiriWavePageState {
  const state = siriWaveStateForMode(input.mode);
  return {
    variant: SIRI_WAVE_VARIANT_BY_STATE[state],
    paused: !input.active,
    reducedMotion: input.reducedMotion,
    opacity: input.mode === "muted" ? 0.35 : state === "idle" ? 0.6 : 1,
    error: state === "error",
  };
}

/**
 * A wide strip renders a taller canvas and crops it, as the web pill does with its square canvas:
 * the shader's wave fills about 40% of the canvas height, so a 9:1 canvas would clip its peaks.
 */
const MAX_CANVAS_ASPECT = 2.5;

export function siriWaveCanvasHeight(width: number, height: number): number {
  return Math.max(height, Math.round(width / MAX_CANVAS_ASPECT));
}

/** Level stretch from `siriWaveStretch`, as a worklet so it runs on the UI thread. */
export function siriWaveStretchWorklet(state: SiriWaveVisualState, level: number): number {
  "worklet";
  if (state === "listening" || state === "speaking") {
    return 0.55 + 0.9 * Math.min(1, Math.max(0, level));
  }
  if (state === "idle" || state === "error") return 0.45;
  return 1;
}

export const SIRI_WAVE_MESSAGE_READY = "siri-wave-ready";
export const SIRI_WAVE_MESSAGE_FAILED = "siri-wave-webgl-failed";

/**
 * The page renders Lilt's shaders unchanged from `antimatter/island/siriWaveShaders.ts`, the
 * same source the Mac, web and Island use. `window.__siri.set(state)` drives it.
 */
export function buildSiriWaveHtml(): string {
  const shaders = JSON.stringify({ vert: SIRI_WAVE_VERT, frags: SIRI_WAVE_SHADERS });
  const script = `(function(){
var S=${shaders};
function post(type){try{window.ReactNativeWebView.postMessage(JSON.stringify({type:type}));}catch(e){}}
var canvas=document.getElementById("c");
var gl=null;
try{gl=canvas.getContext("webgl",{alpha:true,premultipliedAlpha:true,antialias:true});}catch(e){gl=null;}
if(!gl){post(${JSON.stringify(SIRI_WAVE_MESSAGE_FAILED)});return;}
function compile(type,src){var sh=gl.createShader(type);gl.shaderSource(sh,src);gl.compileShader(sh);if(!gl.getShaderParameter(sh,gl.COMPILE_STATUS)){gl.deleteShader(sh);return null;}return sh;}
var programs={};
function program(variant){
  if(programs[variant])return programs[variant];
  var vs=compile(gl.VERTEX_SHADER,S.vert),fs=compile(gl.FRAGMENT_SHADER,S.frags[variant]);
  if(!vs||!fs)return null;
  var p=gl.createProgram();gl.attachShader(p,vs);gl.attachShader(p,fs);gl.bindAttribLocation(p,0,"aPos");gl.linkProgram(p);
  if(!gl.getProgramParameter(p,gl.LINK_STATUS))return null;
  programs[variant]={p:p,res:gl.getUniformLocation(p,"iResolution"),time:gl.getUniformLocation(p,"iTime")};
  return programs[variant];
}
var buf=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buf);
gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
var state={variant:"wave",paused:true,reducedMotion:false,opacity:1,error:false};
var raf=0,start=performance.now(),pxW=0,pxH=0;
function resize(){var dpr=Math.min(window.devicePixelRatio||1,2)*0.75;pxW=Math.max(1,Math.round(window.innerWidth*dpr));pxH=Math.max(1,Math.round(window.innerHeight*dpr));canvas.width=pxW;canvas.height=pxH;gl.viewport(0,0,pxW,pxH);}
function frame(){
  raf=0;
  var prog=program(state.variant);
  if(!prog){post(${JSON.stringify(SIRI_WAVE_MESSAGE_FAILED)});return;}
  gl.useProgram(prog.p);
  gl.uniform2f(prog.res,pxW,pxH);
  gl.uniform1f(prog.time,state.reducedMotion?1.2:(performance.now()-start)/1000);
  gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
  gl.drawArrays(gl.TRIANGLES,0,3);
  if(!state.paused&&!state.reducedMotion&&!document.hidden)raf=requestAnimationFrame(frame);
}
function restart(){if(raf)cancelAnimationFrame(raf);raf=0;frame();}
window.__siri={set:function(next){
  state=next;
  canvas.style.opacity=String(next.opacity);
  canvas.style.filter=next.error?"sepia(1) saturate(6) hue-rotate(-40deg)":"none";
  restart();
}};
window.addEventListener("resize",function(){resize();restart();});
document.addEventListener("visibilitychange",function(){if(document.hidden){if(raf)cancelAnimationFrame(raf);raf=0;}else{restart();}});
resize();
post(${JSON.stringify(SIRI_WAVE_MESSAGE_READY)});
})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;}canvas{display:block;width:100%;height:100%;background:transparent;transition:opacity 300ms ease;}</style></head><body><canvas id="c"></canvas><script>${script}</script></body></html>`;
}
