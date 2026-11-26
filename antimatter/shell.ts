import type { Plugin } from "vite-plus";

// Loads the mattr shell stylesheet after the app's own CSS, from the web entry, so no upstream
// file imports it. The UI font call goes first in the entry's body (imports are hoisted), so the
// saved face applies before the first render. Tests skip it, like the rebrand.
export function mattrShellPlugin(): Plugin {
  return {
    name: "antimatter:shell",
    transform(code, id) {
      if (process.env.VITEST) return null;
      const path = id.split("?")[0] ?? id;
      if (!path.endsWith("/apps/web/src/main.tsx")) return null;
      return {
        code:
          `import { startMattrUiFont } from "./mattrUiFont";\nstartMattrUiFont();\n` +
          `${code}\nimport "../../../antimatter/shell.css";\n`,
        map: null,
      };
    },
  };
}
