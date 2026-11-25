export interface SfFill {
  readonly d: string;
  readonly evenOdd: boolean;
  readonly gray: number;
  readonly mask?: SfMask | null;
}

/** A soft mask: luminance of `fills` painted over `backdrop`, or their coverage when `alpha`. */
export interface SfMask {
  readonly alpha: boolean;
  readonly backdrop: number;
  readonly fills: ReadonlyArray<SfFill>;
}

export interface SfGlyph {
  readonly width: number;
  readonly height: number;
  readonly fills: ReadonlyArray<SfFill>;
}

// Passed in by the generated module: this file sits outside the web app, where "react" doesn't resolve.
interface ReactRuntime {
  createElement(
    type: string,
    props: Record<string, unknown> | null,
    ...children: unknown[]
  ): unknown;
  useId(): string;
}

// Glyphs come from 20pt symbols. Lucide draws on a 24-unit grid with about 2 units of padding,
// and a 30pt square around each symbol gives it the same visual size at the app's icon classes.
const BOX = 30;

const grayFill = (level: number) => {
  const value = Math.round(level * 255);
  return `rgb(${value},${value},${value})`;
};

const lucideClassName = (name: string) =>
  `lucide lucide-${name
    .replace(/Icon$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()}`;

/** A drop-in for a lucide-react icon component that draws an SF Symbol instead. */
export function createSfSymbolIcon(react: ReactRuntime, lucideName: string, glyph: SfGlyph) {
  const baseClassName = lucideClassName(lucideName);
  const x = (glyph.width - BOX) / 2;
  const y = (glyph.height - BOX) / 2;
  const viewBox = `${x} ${y} ${BOX} ${BOX}`;

  function SfSymbolIcon(props: Record<string, unknown>) {
    const {
      size = 24,
      color = "currentColor",
      className,
      children,
      strokeWidth: _strokeWidth,
      absoluteStrokeWidth: _absoluteStrokeWidth,
      fill: _fill,
      ...rest
    } = props;
    const id = react.useId().replace(/[^\w-]/g, "");
    const shapes = glyph.fills.flatMap((fill, index) => {
      const path = (maskId: string | null) =>
        react.createElement("path", {
          d: fill.d,
          fillRule: fill.evenOdd ? "evenodd" : undefined,
          stroke: "none",
          mask: maskId ? `url(#${maskId})` : undefined,
        });
      const { mask } = fill;
      if (!mask) return [path(null)];
      const maskId = `${id}-sf${index}`;
      return [
        react.createElement(
          "mask",
          { id: maskId, maskUnits: "userSpaceOnUse", x, y, width: BOX, height: BOX },
          react.createElement("rect", {
            x,
            y,
            width: BOX,
            height: BOX,
            fill: mask.alpha ? "black" : grayFill(mask.backdrop),
          }),
          ...mask.fills.map((maskFill) =>
            react.createElement("path", {
              d: maskFill.d,
              fillRule: maskFill.evenOdd ? "evenodd" : undefined,
              fill: mask.alpha ? "white" : grayFill(maskFill.gray),
            }),
          ),
        ),
        path(maskId),
      ];
    });
    return react.createElement(
      "svg",
      {
        xmlns: "http://www.w3.org/2000/svg",
        width: size,
        height: size,
        viewBox,
        fill: color,
        "aria-hidden": rest["aria-label"] === undefined ? "true" : undefined,
        ...rest,
        className: typeof className === "string" ? `${baseClassName} ${className}` : baseClassName,
      },
      ...shapes,
      children,
    );
  }
  SfSymbolIcon.displayName = lucideName;
  return SfSymbolIcon;
}
