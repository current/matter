// Rewrites upstream's product names in mobile bundles at Metro time, so the rebrand covers every
// new upstream string without editing (and conflicting with) upstream files.
const CLIENT_SOURCE = /\/(apps\/mobile\/src|packages\/[^/]+\/src)\//;
// Thread lifecycle words follow the web build: upstream's "Archive" reads "Hide", "Settle" reads
// "Archive". Only translated copy (msg/gt arguments and <T> text) changes, never keys or values.
const { rebrandTerminologyText } = require("./rebrand.ts");
const I18N_CALLS = new Set(["msg", "gt"]);
const PROJECT_CONTEXT = /project/i;

const isProjectContext = (call) => {
  const options = call.arguments[1];
  if (options?.type !== "ObjectExpression") return false;
  return options.properties.some(
    (property) =>
      property.type === "ObjectProperty" &&
      (property.key.name ?? property.key.value) === "$context" &&
      property.value.type === "StringLiteral" &&
      PROJECT_CONTEXT.test(property.value.value),
  );
};

const terminologyFor = (path) => {
  const call = path.parent;
  if (
    call.type === "CallExpression" &&
    call.arguments[0] === path.node &&
    call.callee.type === "Identifier" &&
    I18N_CALLS.has(call.callee.name)
  ) {
    return { skipArchiveToHide: isProjectContext(call) };
  }
  const element = path.parentPath?.node;
  if (
    path.node.type === "JSXText" &&
    element?.type === "JSXElement" &&
    element.openingElement.name.type === "JSXIdentifier" &&
    element.openingElement.name.name === "T"
  ) {
    return {};
  }
  return null;
};

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
  const update = (path, key, extra) => {
    const node = path.node;
    const terminology = terminologyFor(path);
    const branded = rebrand(node[key]);
    const next = terminology ? rebrandTerminologyText(branded, terminology) : branded;
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
        update(path, "value", true);
      },
      JSXText(path, state) {
        if (applies(state)) update(path, "value", true);
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
