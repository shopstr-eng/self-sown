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
    // Type-aware block, scoped to API routes: `return someHelper()` (no await)
    // inside a try/catch lets an async throw escape the route's error mapping
    // as an unhandled rejection. The rule requires type info, so it stays out
    // of the base block to keep repo-wide lint fast.
    files: ["pages/api/**/*.{ts,tsx}"],
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
];
