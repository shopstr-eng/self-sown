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
        { checksConditionals: true, checksVoidReturn: true, checksSpreads: false },
      ],
    },
  },
];
