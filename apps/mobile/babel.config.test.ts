import * as NodeModule from "node:module";
import { afterEach, expect, it, vi } from "vite-plus/test";

import mattrMobileRebrand from "../../antimatter/mobile-rebrand-babel.cjs";

// @babel/core ships without types; only this call is needed.
const { transformSync } = NodeModule.createRequire(import.meta.url)("@babel/core") as {
  readonly transformSync: (
    code: string,
    options: object,
  ) => { readonly code?: string | null } | null;
};

afterEach(() => vi.unstubAllEnvs());

function transform(code: string, filename: string) {
  // The plugin stands down under Vitest so other tests keep upstream copy; this one opts in.
  vi.stubEnv("VITEST", "");
  return transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ["jsx", "typescript"] },
    plugins: [mattrMobileRebrand],
  })?.code;
}

it("rebrands copy in mobile sources without touching module paths", () => {
  const output = transform(
    [
      'import x from "./T3 Code";',
      'const title = "Open T3 Code";',
      "const product = `T3 Connect on ${host}`;",
      "const view = <Text>About T3 Code</Text>;",
      'const app = "T3 Code for GitHub";',
    ].join("\n"),
    "/repo/apps/mobile/src/features/About.tsx",
  );
  expect(output).toContain('import x from "./T3 Code";');
  expect(output).toContain('"Open mattr"');
  expect(output).toContain("`mattr Connect on ${host}`");
  expect(output).toContain("About mattr");
  expect(output).toContain('"T3 Code for GitHub"');
});

it("leaves dependencies alone", () => {
  const code = 'const title = "T3 Code";';
  expect(transform(code, "/repo/node_modules/pkg/src/index.ts")).toBe(code);
  expect(transform(code, "/repo/apps/mobile/scripts/build.ts")).toBe(code);
});
