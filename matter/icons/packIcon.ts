import {
  getIconPackState,
  iconPackSource,
  subscribeIconPack,
  type IconPackState,
} from "./iconPack";
import { lucideClassName } from "./sfSymbolIcon";

// Passed in by the generated module: this file sits outside the web app, where "react" doesn't resolve.
interface ReactElementRuntime {
  createElement(
    type: unknown,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
}
interface ReactRuntime extends ReactElementRuntime {
  useSyncExternalStore(
    subscribe: (listener: () => void) => () => void,
    getSnapshot: () => IconPackState,
    getServerSnapshot: () => IconPackState,
  ): IconPackState;
}

// Orca's chrome uses lucide at 1.5; a caller's own strokeWidth scales from lucide's default 2.
const ORCA_STROKE = 1.5;
const LUCIDE_STROKE = 2;

const orcaStroke = (strokeWidth: unknown) => {
  const value = typeof strokeWidth === "string" ? Number.parseFloat(strokeWidth) : strokeWidth;
  return typeof value === "number" && Number.isFinite(value)
    ? (ORCA_STROKE * value) / LUCIDE_STROKE
    : ORCA_STROKE;
};

export interface PackIconSpec {
  /** The export name this component replaces. */
  readonly name: string;
  /** The lucide name whose pack mappings it draws (differs only for titlebar overrides). */
  readonly packKey: string;
  readonly Lucide: unknown;
  readonly Sf: unknown;
}

const SPEC = Symbol.for("matter.packIconSpec");
const baseClassNames = new Map<string, string>();

/** The pack spec behind an icon from the lucide-react stand-in; null when icons aren't swapped. */
export function packIconSpecOf(icon: unknown): PackIconSpec | null {
  const spec = (icon as { [SPEC]?: PackIconSpec } | null)?.[SPEC];
  return spec ?? null;
}

/** Draws one icon in `pack` (null holds its box while a lazy pack loads). Settings previews use it directly. */
export function drawPackIcon(
  react: ReactElementRuntime,
  spec: PackIconSpec,
  pack: IconPackState["shown"],
  sources: IconPackState["sources"],
  props: Record<string, unknown>,
): unknown {
  let baseClassName = baseClassNames.get(spec.packKey);
  if (baseClassName === undefined) {
    baseClassName = lucideClassName(spec.packKey);
    baseClassNames.set(spec.packKey, baseClassName);
  }
  if (pack === "lucide-orca") {
    return react.createElement(spec.Lucide, {
      ...props,
      strokeWidth: orcaStroke(props.strokeWidth),
    });
  }
  if (pack === "sf-symbols-fill") return react.createElement(spec.Sf ?? spec.Lucide, props);

  const {
    size = 24,
    color = "currentColor",
    className,
    children: _children,
    strokeWidth: _strokeWidth,
    absoluteStrokeWidth: _absoluteStrokeWidth,
    fill: _fill,
    ...rest
  } = props;
  const classes = typeof className === "string" ? `${baseClassName} ${className}` : baseClassName;

  // A lazy pack still loading on first paint: hold the icon's box instead of flashing another set.
  if (pack === null) {
    return react.createElement("svg", {
      "aria-hidden": "true",
      ...rest,
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      className: classes,
    });
  }

  const source = iconPackSource(pack);
  const glyph = source === null ? undefined : sources[source]?.[spec.packKey];
  if (glyph === undefined) return react.createElement(spec.Lucide, props);
  return react.createElement("svg", {
    xmlns: "http://www.w3.org/2000/svg",
    "aria-hidden": rest["aria-label"] === undefined ? "true" : undefined,
    ...rest,
    width: size,
    height: size,
    viewBox: glyph[1],
    color,
    className: classes,
    dangerouslySetInnerHTML: { __html: glyph[0] },
  });
}
/** A drop-in for a lucide-react icon that draws the icon pack chosen in Settings → Appearance. */
export function createPackIcon(react: ReactRuntime, spec: PackIconSpec) {
  function MatterIcon(props: Record<string, unknown>) {
    const state = react.useSyncExternalStore(subscribeIconPack, getIconPackState, getIconPackState);
    return drawPackIcon(react, spec, state.shown, state.sources, props);
  }
  MatterIcon.displayName = spec.name;
  return Object.assign(MatterIcon, { [SPEC]: spec });
}
