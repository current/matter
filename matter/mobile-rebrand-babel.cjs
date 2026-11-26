// Rewrites upstream's product names in mobile bundles at Metro time, so the rebrand covers every
// new upstream string without editing (and conflicting with) upstream files.
const CLIENT_SOURCE = /\/(apps\/mobile\/src|packages\/[^/]+\/src)\//;

const rebrand = (text) =>
  text
    .replace(/\bT3(\s+)Connect\b/g, "Matter$1Connect")
    .replace(/\bT3(\s+)Code(?! for GitHub)/g, "Matter")
    .replace(/\bT3%20Code\b/g, "Matter")
    .replace(/\bT3(\s+)(threads?\b|home\b|desktop\b)/g, "Matter$1$2");

module.exports = function matterMobileRebrand() {
  // Tests assert upstream's English copy.
  if (process.env.VITEST) return { name: "matter-mobile-rebrand", visitor: {} };

  const applies = (state) => {
    const filename = state.filename?.split("\\").join("/") ?? "";
    return CLIENT_SOURCE.test(filename) && !filename.includes("/node_modules/");
  };
  const update = (node, key, extra) => {
    const next = rebrand(node[key]);
    if (next === node[key]) return;
    node[key] = next;
    if (extra) delete node.extra;
  };

  return {
    name: "matter-mobile-rebrand",
    visitor: {
      StringLiteral(path, state) {
        if (!applies(state)) return;
        if (path.parent.type === "ImportDeclaration" || path.parent.type === "ExportAllDeclaration")
          return;
        update(path.node, "value", true);
      },
      JSXText(path, state) {
        if (applies(state)) update(path.node, "value", true);
      },
      TemplateElement(path, state) {
        if (!applies(state)) return;
        const { value } = path.node;
        const raw = rebrand(value.raw);
        if (raw === value.raw) return;
        value.raw = raw;
        if (value.cooked != null) value.cooked = rebrand(value.cooked);
      },
    },
  };
};
