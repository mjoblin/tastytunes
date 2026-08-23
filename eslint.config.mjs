// ESLint (flat config) — lint rules only; layout belongs to Prettier
// (eslint-config-prettier, last, switches off every formatting rule).
//
// Decisions (2026-08-22, the tooling round for 0.4.0-rc.2):
// - typescript-eslint's type-checked recommended set, project-aware.
// - react-hooks: rules-of-hooks + exhaustive-deps ONLY. The plugin's v7
//   "recommended" preset adds React-Compiler readiness rules (set-state-in-
//   effect, refs, purity, …) that flag patterns this app uses on purpose
//   (ModalShell holding its last children in a ref, hold-and-settle effects,
//   Date.now() in the playhead). We don't use the compiler; revisit if we do.
// - restrict-template-expressions: numbers, booleans and nullish are fine in
//   template strings here (ids, counts, optional fields in log lines).
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  // src only: the type-aware rules need a tsconfig, and the root configs,
  // scripts/ and dev/ are plain JS outside both project files; the ipad spike
  // (apple branch) is its own project with its own tsconfig
  {
    ignores: [
      "out/**",
      "dist/**",
      "node_modules/**",
      "dev/**",
      "resources/**",
      "build/**",
      "scripts/**",
      ".github/**",
      "**/*.mjs",
      "**/*.js",
      "*.ts",
      "ipad/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
      // MCP tool arguments arrive untyped (any) and are interpolated into replies;
      // typing them at the boundary is its own round.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        {
          allowNumber: true,
          allowBoolean: true,
          allowNullish: true,
          allowRegExp: true,
          allowAny: true,
        },
      ],
      // Every hit is a callback PROP or hook result (onClose(): void) pulled
      // off an object — plain functions with no `this` to lose. No class here
      // hands its methods out detached.
      "@typescript-eslint/unbound-method": "off",
      // The XML/JSON parsers hand back `unknown` by design and String() is the
      // intended coercion at those seams (didl.ts, the demo streamer, MCP).
      "@typescript-eslint/no-base-to-string": "off",
      // Untyped boundaries (JSON.parse of our own files, the XML parser, the
      // wire, caught errors) narrow through src/shared/guards.ts before typed
      // code touches them (2026-08-23) — so these are errors, like the rest.
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { ignoreRestSiblings: true, argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // "next · title": the no-break spaces around the middle dot are deliberate
      "no-irregular-whitespace": ["error", { skipTemplates: true }],
    },
  },
  prettier,
);
