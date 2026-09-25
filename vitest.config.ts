// Unit tests (Vitest). Tests sit beside the module they guard as *.test.ts
// under src/, and run in plain Node: they cover the PURE modules only
// (placement maths, the DIDL parser and its pool rules, the shared model's
// rules, the renderer's formatters and audio maths), so no DOM and no
// Electron. The aliases mirror electron.vite.config.ts; the build never sees
// a test, since no entry imports one.
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
    include: ["src/**/*.test.ts"],
  },
});
