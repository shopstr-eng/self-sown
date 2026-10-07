/** @jest-environment node */
// Regression guard for the EAS READ_APP_CONFIG failure: the EAS build worker
// evaluates apps/mobile/app.config.ts WITHOUT a TypeScript transpiler, so any
// TS-only syntax (import type, annotations, `as` casts) breaks cloud builds
// even though local Node 22 type-stripping hides it. Copying the file to a
// .mjs sibling makes local Node parse it as plain JavaScript — the same view
// the worker gets — so a TS-only construct fails here instead of mid-build.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, unlinkSync } from "node:fs";
import path from "node:path";
// Imported only so `jest --findRelatedTests` (pre-commit) runs this suite
// whenever app.config.ts is staged; the real check shells out to plain Node.
import "../../apps/mobile/app.config";

const MOBILE_DIR = path.join(__dirname, "..", "..", "apps", "mobile");
const CHECK_FILE = path.join(
  MOBILE_DIR,
  `.app-config.eas-check.${process.pid}.mjs`
);
const VALID_PROJECT_ID = "123e4567-e89b-12d3-a456-426614174000";

const minimalEnv: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  NODE_ENV: "test",
};

beforeAll(() => {
  copyFileSync(path.join(MOBILE_DIR, "app.config.ts"), CHECK_FILE);
});

afterAll(() => {
  unlinkSync(CHECK_FILE);
});

test("dev path evaluates as plain JavaScript with no env vars set", () => {
  // MOBILE_APP_VARIANT unset: the local-development branch must need nothing.
  expect(() =>
    execFileSync(process.execPath, [CHECK_FILE], {
      cwd: MOBILE_DIR,
      env: minimalEnv,
      stdio: ["ignore", "pipe", "pipe"],
    })
  ).not.toThrow();
});

test("production path evaluates with release env vars set", () => {
  const result = spawnSync(process.execPath, [CHECK_FILE], {
    cwd: MOBILE_DIR,
    env: {
      ...minimalEnv,
      MOBILE_APP_VARIANT: "production",
      EXPO_PUBLIC_API_BASE_URL: "https://api.example.com",
      EAS_PROJECT_ID: VALID_PROJECT_ID,
    },
    encoding: "utf8",
  });
  expect(result.status).toBe(0);
});

test("release-only validation branch rejects a missing API deployment URL", () => {
  // Proves the release branch above is really exercised: with the variant set
  // but no EXPO_PUBLIC_API_BASE_URL, the config must fail loudly.
  const result = spawnSync(process.execPath, [CHECK_FILE], {
    cwd: MOBILE_DIR,
    env: {
      ...minimalEnv,
      MOBILE_APP_VARIANT: "production",
      EAS_PROJECT_ID: VALID_PROJECT_ID,
    },
    encoding: "utf8",
  });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/HTTPS API deployment/);
});

test("shared validator stays plain CommonJS loadable without a transpiler", () => {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      "const v = require('./lib/api-configuration.js'); if (typeof v.resolveMobileApiBaseUrl !== 'function') process.exit(1);",
    ],
    { cwd: MOBILE_DIR, env: minimalEnv, encoding: "utf8" }
  );
  expect(result.status).toBe(0);
});
