import type { Element, ElementContent, Root } from "hast";

import type { MattrAnimatedStream } from "../../mattrStreamAnimation";
import type { MarkdownIslandOptions } from "./markdownIslands";

/** Each word of streamed prose; CSS animates it once, when React first mounts it. */
export const STREAM_WORD_CLASS = "mattr-sw";
export const STREAM_CARET_CLASS = "mattr-stream-caret";

/** Text inside these keeps upstream's rendering; inline code animates as one unit instead. */
const OPAQUE_TAGS = new Set([
  "pre",
  "code",
  "a",
  "table",
  "img",
  "svg",
  "math",
  "details",
  "input",
  "kbd",
  "script",
  "style",
]);

/** Elements the caret may end, after their last word. */
const CARET_HOSTS = new Set([
  "p",
  "li",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "strong",
  "em",
  "b",
  "i",
  "del",
  "s",
  "mark",
]);
/** Elements the caret looks inside for the last line. */
const CARET_CONTAINERS = new Set([...CARET_HOSTS, "ul", "ol", "blockquote", "div"]);

const TOKEN_PATTERN = /\s+|\S+/g;

/** Splits text into alternating words and runs of space, in order. */
export function splitStreamWords(value: string): string[] {
  return value.match(TOKEN_PATTERN) ?? [];
}

const isSpace = (token: string) => /\s/.test(token[0]!);

// Word spans render through React (as islands), so the spans already on screen keep their DOM
// nodes, and their finished animation, while later words mount and animate.
const wordNodes = new WeakSet<Element>();
// Rebuilt containers are known not to be islands; their originals were checked before rebuilding.
const rebuiltNodes = new WeakSet<Element>();

function wordElement(value: string): Element {
  const node: Element = {
    type: "element",
    tagName: "span",
    properties: { className: [STREAM_WORD_CLASS] },
    children: [{ type: "text", value }],
  };
  wordNodes.add(node);
  return node;
}

function caretElement(): Element {
  return {
    type: "element",
    tagName: "span",
    properties: { className: [STREAM_CARET_CLASS], ariaHidden: "true" },
    children: [],
  };
}

function rebuilt<T extends Root | Element>(node: T, children: ElementContent[]): T {
  const copy = { ...node, children };
  if (copy.type === "element") rebuiltNodes.add(copy);
  return copy;
}

function withClass(node: Element, className: string): Element {
  const existing: unknown = node.properties.className;
  const classes = Array.isArray(existing)
    ? existing.map(String)
    : typeof existing === "string"
      ? existing.split(" ")
      : [];
  return { ...node, properties: { ...node.properties, className: [...classes, className] } };
}

function splitChildren(
  children: ReadonlyArray<ElementContent>,
  isIsland: (node: Element) => boolean,
): ElementContent[] | null {
  let next: ElementContent[] | null = null;
  for (let index = 0; index < children.length; index++) {
    const child = children[index]!;
    let replacement: ElementContent | ElementContent[] = child;
    if (child.type === "text") {
      // Space stays plain text between words, so an inline-block word never swallows it.
      if (child.value.trim() !== "") {
        replacement = splitStreamWords(child.value).map((token) =>
          isSpace(token) ? { type: "text", value: token } : wordElement(token),
        );
      }
    } else if (child.type === "element" && !isIsland(child)) {
      if (child.tagName === "code") {
        replacement = withClass(child, STREAM_WORD_CLASS);
      } else if (!OPAQUE_TAGS.has(child.tagName)) {
        const inner = splitChildren(child.children, isIsland);
        if (inner) replacement = rebuilt(child, inner);
      }
    }
    if (replacement !== child && next === null) next = children.slice(0, index);
    if (next === null) continue;
    if (Array.isArray(replacement)) next.push(...replacement);
    else next.push(replacement);
  }
  return next;
}

function lastContentIndex(children: ReadonlyArray<ElementContent>): number {
  let index = children.length - 1;
  while (index >= 0) {
    const child = children[index]!;
    if (child.type === "element" || (child.type === "text" && child.value.trim() !== "")) break;
    index--;
  }
  return index;
}

/** The tree with a caret after its last word, or null when the text ends in a block like code. */
function withCaret<T extends Root | Element>(node: T): T | null {
  const index = lastContentIndex(node.children as ElementContent[]);
  const last = node.children[index];
  if (last?.type === "element" && !wordNodes.has(last) && last.tagName !== "code") {
    if (!rebuiltNodes.has(last) || !CARET_CONTAINERS.has(last.tagName)) return null;
    const inner = withCaret(last);
    if (!inner) return null;
    const children = node.children.slice() as ElementContent[];
    children[index] = inner;
    return rebuilt(node, children);
  }
  if (node.type !== "element" || !CARET_HOSTS.has(node.tagName) || last === undefined) return null;
  const children = node.children.slice(0, index + 1) as ElementContent[];
  children.push(caretElement());
  return rebuilt(node, children);
}

const optionsByBase = new WeakMap<MarkdownIslandOptions, MarkdownIslandOptions>();

function streamIslandOptions(base: MarkdownIslandOptions): MarkdownIslandOptions {
  let options = optionsByBase.get(base);
  if (!options) {
    options = {
      ...base,
      isIsland: (node) => wordNodes.has(node) || (!rebuiltNodes.has(node) && base.isIsland(node)),
    };
    optionsByBase.set(base, options);
  }
  return options;
}

// One rebuilt tree per parsed tree, so a block that hasn't changed renders from React's cache.
const treesBySource = new WeakMap<Root, { caret: boolean; tree: Root }>();

/** Modes that ride a caret on the end of the live text. */
const CARET_ANIMATIONS = new Set<MattrAnimatedStream>(["blur", "typewriter"]);

/**
 * The tree and island options for one block of a streaming message. Without an animation it
 * returns its inputs untouched, so finished messages render exactly as upstream renders them.
 */
export function mattrStreamHast(
  tree: Root,
  options: MarkdownIslandOptions,
  animation: MattrAnimatedStream | null,
  liveBlock: boolean,
): [Root, MarkdownIslandOptions] {
  if (animation === null) return [tree, options];
  const caret = liveBlock && CARET_ANIMATIONS.has(animation);
  const cached = treesBySource.get(tree);
  if (cached?.caret === caret) return [cached.tree, streamIslandOptions(options)];
  const split = splitChildren(tree.children as ElementContent[], options.isIsland);
  let next: Root = split ? rebuilt(tree, split) : tree;
  if (caret) next = withCaret(next) ?? next;
  treesBySource.set(tree, { caret, tree: next });
  return [next, streamIslandOptions(options)];
}
