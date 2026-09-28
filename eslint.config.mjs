import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import nextPlugin from "@next/eslint-plugin-next";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";

export default [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "public/**",
      "**/dist/**",
      "**/*.js",
      ".local/skills/",
    ],
  },
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "@next/next": nextPlugin,
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // `new Promise(async (resolve, reject) => ...)` turns post-await errors
      // into unhandled rejections that silently hang the UI. Use
      // utils/promise-from-async.ts when a resolve/reject closure is needed.
      "no-async-promise-executor": "error",
    },
  },
  {
    // Type-aware block, scoped to server-side code: `return someHelper()`
    // (no await) inside a try/catch lets an async throw escape the handler's
    // error mapping as an unhandled rejection, silently skipping cleanup,
    // claim release, or error logging. Covers API routes, the MCP server, and
    // utils/ (the modules called from API/webhook/cron handlers). Client-side
    // components are intentionally excluded — the bug shape is server-specific.
    // The rule requires type info, so it stays out of the base block to keep
    // repo-wide lint fast.
    files: ["pages/api/**/*.{ts,tsx}", "mcp/**/*.ts", "utils/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        // tsconfig.eslint.json covers pages/api/mcp and the .well-known
        // dot-directory, which the root tsconfig misses.
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
    },
  },
  {
    // Scoped to server-side code: an async guard (rate limit, auth,
    // entitlement check) invoked without await is always truthy, so
    // `if (!guard(...)) return;` silently never blocks anything and the
    // guard's side effects (e.g. 429 + header stamping) race the response.
    // Covers API routes, the MCP server (agent-facing tools with their own
    // auth/tier enforcement), utils/ (shared modules called from
    // webhook/cron handlers), and scripts/ (one-off backfill/reconciliation
    // ops scripts that run directly against the production database, where an
    // un-awaited guard fails silently with higher stakes). Intentional
    // fire-and-forget calls must be marked with `void`.
    files: [
      "pages/api/**/*.{ts,tsx}",
      "mcp/**/*.ts",
      "utils/**/*.{ts,tsx}",
      "scripts/**/*.ts",
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Statement-level: an async call whose result is dropped entirely.
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: true, ignoreIIFE: false },
      ],
      // Conditional-level: `if (!guard(...))` on an async guard — a promise
      // is always truthy, so the check silently never blocks anything. This
      // is the exact missing-await bug shape this block exists to catch.
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksConditionals: true,
          checksVoidReturn: true,
          checksSpreads: false,
        },
      ],
    },
  },
  {
    // Shared-packages + mobile block: the same two silent-failure shapes the
    // web server/client blocks catch — an async throw escaping a try/catch as
    // an unhandled rejection (return-await), and an async guard invoked
    // without await so it never blocks anything (no-misused-promises
    // conditionals). packages/* is imported by both the web app and the
    // mobile app, so a bug here lands in both. The root tsconfig.eslint.json
    // excludes apps/ and packages/, so this block wires each workspace's own
    // tsconfig for type info instead. Intentional fire-and-forget calls must
    // be marked with `void`. no-floating-promises stays off for the React
    // Native app, matching the web client block (effect/telemetry
    // fire-and-forget is idiomatic in components).
    files: [
      "packages/domain/**/*.ts",
      "packages/nostr/**/*.ts",
      "packages/api-client/**/*.ts",
      "apps/mobile/**/*.{ts,tsx}",
    ],
    languageOptions: {
      parserOptions: {
        project: [
          "packages/domain/tsconfig.json",
          "packages/nostr/tsconfig.json",
          "packages/api-client/tsconfig.json",
          "apps/mobile/tsconfig.json",
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksConditionals: true,
          checksVoidReturn: true,
          checksSpreads: false,
        },
      ],
    },
  },
  {
    // Client-side event-handler block: an onClick/onSubmit wired directly to
    // an async function returns a promise nobody awaits, so a rejection
    // vanishes — the buyer/seller sees nothing happen and no error is logged.
    // checksVoidReturn flags exactly that shape (async fn passed where a
    // void-returning callback is expected, e.g. JSX event handlers and
    // HeroUI onPress). Intentional fire-and-forget handlers must be marked
    // with `void` (or an arrow body that voids the call); genuine bugs get
    // real error handling. Deliberately narrower than the server block: no
    // no-floating-promises (effect/telemetry fire-and-forget is idiomatic in
    // components) and no checksConditionals (the always-truthy guard shape is
    // a server-auth bug, not a UI one). pages/api stays under the stricter
    // server block above.
    files: ["components/**/*.{ts,tsx}", "pages/**/*.{ts,tsx}"],
    ignores: ["pages/api/**"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-misused-promises": [
        "error",
        {
          checksConditionals: false,
          checksVoidReturn: true,
          checksSpreads: false,
        },
      ],
    },
  },
];
