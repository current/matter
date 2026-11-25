import { memo, useEffect, useRef, type CSSProperties } from "react";
import {
  SIRI_WAVE_SHADERS,
  SIRI_WAVE_VARIANT_BY_STATE,
  SIRI_WAVE_VERT,
  siriWaveStretch,
  type SiriWaveVariant,
  type SiriWaveVisualState,
} from "../../../../antimatter/island/siriWaveShaders";

export type { SiriWaveVariant, SiriWaveVisualState };

export interface SiriWaveCanvasProps {
  readonly variant?: SiriWaveVariant;
  readonly width?: number;
  readonly height?: number;
  readonly renderScale?: number;
  readonly paused?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

const SiriWaveCanvas = memo(function SiriWaveCanvas({
  variant = "wave",
  width = 160,
  height = width,
  renderScale = 1,
  paused = false,
  className,
  style,
}: SiriWaveCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- drives WebGL shader canvas while mounted and unpaused
  useEffect(() => {
    if (paused) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
    } catch {
      gl = null;
    }
    if (!gl) return;

    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type);
      if (!sh) throw new Error("shader alloc failed");
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(log ?? "shader compile error");
      }
      return sh;
    };

    const prog = gl.createProgram();
    if (!prog) return;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    try {
      vs = compile(gl.VERTEX_SHADER, SIRI_WAVE_VERT);
      fs = compile(gl.FRAGMENT_SHADER, SIRI_WAVE_SHADERS[variant]);
      gl.attachShader(prog, vs);
      gl.attachShader(prog, fs);
      gl.linkProgram(prog);
      // Bind WebGL's useProgram so React's hook-name lint does not treat it as a hook.
      const activateProgram = gl.useProgram.bind(gl);
      activateProgram(prog);
    } catch {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      gl.deleteProgram(prog);
      return;
    }

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const uRes = gl.getUniformLocation(prog, "iResolution");
    const uTime = gl.getUniformLocation(prog, "iTime");

    const dpr = typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    const pxW = Math.max(1, Math.round(width * renderScale * dpr));
    const pxH = Math.max(1, Math.round(height * renderScale * dpr));
    canvas.width = pxW;
    canvas.height = pxH;
    gl.viewport(0, 0, pxW, pxH);

    const reducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    const start = typeof performance !== "undefined" ? performance.now() : Date.now();
    let raf = 0;

    const draw = () => {
      const t = reducedMotion
        ? 1.2
        : ((typeof performance !== "undefined" ? performance.now() : Date.now()) - start) / 1000;
      gl.uniform2f(uRes, pxW, pxH);
      gl.uniform1f(uTime, t);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (!reducedMotion) {
        raf = requestAnimationFrame(draw);
      }
    };
    draw();

    return () => {
      cancelAnimationFrame(raf);
      gl.deleteProgram(prog);
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      if (buf) gl.deleteBuffer(buf);
    };
  }, [variant, width, height, renderScale, paused]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{
        display: "block",
        background: "transparent",
        width,
        height,
        ...style,
      }}
    />
  );
});

export interface SiriWaveVisualProps {
  readonly state: SiriWaveVisualState;
  readonly level: number;
  readonly width?: number;
  readonly height?: number;
  readonly paused?: boolean;
  readonly className?: string;
  readonly style?: CSSProperties;
}

export const SiriWaveVisual = memo(function SiriWaveVisual({
  state,
  level,
  width = 80,
  height = 36,
  paused = false,
  className,
  style,
}: SiriWaveVisualProps) {
  const variant = SIRI_WAVE_VARIANT_BY_STATE[state];
  const canvasSize = Math.max(width, height);
  return (
    <div
      aria-hidden="true"
      className={className}
      style={{
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        overflow: "hidden",
        ...style,
      }}
    >
      {paused ? null : (
        <SiriWaveCanvas
          variant={variant}
          width={canvasSize}
          height={canvasSize}
          renderScale={0.75}
          style={{
            filter: state === "error" ? "sepia(1) saturate(6) hue-rotate(-40deg)" : undefined,
            opacity: state === "idle" ? 0.6 : state === "connecting" ? 0.75 : 1,
            transform: `scaleY(${siriWaveStretch(state, level)})`,
            transition: "opacity 300ms ease, transform 90ms linear",
          }}
        />
      )}
    </div>
  );
});
