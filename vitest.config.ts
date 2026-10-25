// Unit tests (Vitest). Tests sit beside the module they guard as *.test.ts
// under src/, and run in plain Node: the pure modules (placement maths, the
// DIDL parser and its pool rules, the shared model's rules, the renderer's
// formatters and audio maths) and the main process's modules behind one
// electron stub (vitest.setup.ts), so no DOM and no Electron binary: a check
// that opens no window belongs here, where CI runs it on every push. The
// aliases mirror electron.vite.config.ts; the build never sees a test, since
// no entry imports one.
import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve("src/shared"),
      "@": resolve("src/renderer/src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "lint/**/*.test.mjs"],
    setupFiles: ["vitest.setup.ts"],
  },
});
