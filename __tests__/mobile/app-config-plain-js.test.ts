/** @jest-environment node */
// Regression guard for the EAS READ_APP_CONFIG failure: the EAS build worker
// evaluates apps/mobile/app.config.ts WITHOUT a TypeScript transpiler, so any
// TS-only syntax (import type, annotations, `as` casts) breaks cloud builds
// even though local Node 22 type-stripping hides it. Copying the file to a
// .mjs sibling makes local Node parse it as plain JavaScript — the same view
// the worker gets — so a TS-only construct fails here instead of mid-build.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
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

// Value guard: evaluating cleanly is not enough — a typo in these fields
// ships to TestFlight/Play. Expected identifiers are asserted literally (they
// are the store-listing contract); the per-variant env (variant + projectId)
// comes from eas.json so the two files cannot drift.
const easJson = JSON.parse(
  readFileSync(path.join(MOBILE_DIR, "eas.json"), "utf8")
) as {
  build: Record<string, { env?: Record<string, string> }>;
};
type Variant = "development" | "staging" | "production";
const VARIANTS: Variant[] = ["development", "staging", "production"];
const PROFILE_BY_VARIANT: Record<Variant, string> = {
  development: "development",
  staging: "preview",
  production: "production",
};
const EXPECTED_BUNDLE_ID: Record<Variant, string> = {
  development: "com.selfsown.mobile",
  staging: "com.selfsown.mobile.staging",
  production: "com.selfsown.mobile",
};
const EXPECTED_NAME: Record<Variant, string> = {
  development: "Self-sown Vendor",
  staging: "Self-sown Staging",
  production: "Self-sown Vendor",
};

function loadExportedConfig(env: Record<string, string>): any {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `import(${JSON.stringify(
        pathToFileURL(CHECK_FILE).href
      )}).then((m) => process.stdout.write(JSON.stringify(m.default)))`,
    ],
    { cwd: MOBILE_DIR, env: { ...minimalEnv, ...env }, encoding: "utf8" }
  );
  if (result.status !== 0)
    throw new Error(`app.config evaluation failed:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

test.each(VARIANTS)(
  "%s exported config carries the release-critical identifiers from eas.json",
  (variant) => {
    const profile = easJson.build[PROFILE_BY_VARIANT[variant]];
    if (!profile?.env)
      throw new Error(`eas.json is missing the ${variant} build profile env`);
    const env = profile.env;
    expect(env.MOBILE_APP_VARIANT).toBe(variant);

    const config = loadExportedConfig(env);
    expect(config.ios.bundleIdentifier).toBe(EXPECTED_BUNDLE_ID[variant]);
    expect(config.android.package).toBe(EXPECTED_BUNDLE_ID[variant]);
    expect(config.name).toBe(EXPECTED_NAME[variant]);
    expect(config.slug).toBe("self-sown-mobile");
    expect(config.owner).toBe("shopstr-markets");
    expect(config.scheme).toEqual(
      expect.arrayContaining(["selfsown", "milkmarket"])
    );
    expect(config.extra.appVariant).toBe(variant);
    expect(config.extra.eas.projectId).toBe(env.EAS_PROJECT_ID);
  }
);

test("exported config omits extra.eas when no project id is set", () => {
  const config = loadExportedConfig({});
  expect(config.extra.appVariant).toBe("development");
  expect(config.extra.eas).toBeUndefined();
});

// Asset guard: app.config references binaries by relative path and nothing
// resolves them until mid-way through an EAS cloud build. Collect every image
// path the exported config carries and assert each exists under apps/mobile/.
function collectImageAssetPaths(config: any): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  if (typeof config?.icon === "string") entries.push(["icon", config.icon]);
  const foreground = config?.android?.adaptiveIcon?.foregroundImage;
  if (typeof foreground === "string")
    entries.push(["android.adaptiveIcon.foregroundImage", foreground]);
  for (const plugin of config?.plugins ?? []) {
    const [name, options] = Array.isArray(plugin) ? plugin : [plugin];
    if (name === "expo-splash-screen" && typeof options?.image === "string")
      entries.push(["plugins[expo-splash-screen].image", options.image]);
  }
  return entries;
}

test("every image asset the exported config references exists on disk", () => {
  const config = loadExportedConfig({});
  const missing = collectImageAssetPaths(config).filter(
    ([, relativePath]) =>
      !existsSync(path.resolve(MOBILE_DIR, relativePath))
  );
  expect(
    missing.map(
      ([field, relativePath]) =>
        `${field} points at ${relativePath}, which does not exist under apps/mobile/`
    )
  ).toEqual([]);
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
