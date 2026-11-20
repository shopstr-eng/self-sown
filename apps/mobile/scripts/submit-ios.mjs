// Submit an App Store build to TestFlight/App Review — but only after the built
// IPA passes the Tap to Pay entitlement check. This wrapper exists so a build
// that silently lost the proximity-reader entitlement cannot reach Apple: the
// check runs first and aborts submission (non-zero exit) on failure.
//
// Prefer this over a bare `eas submit`:
//   node scripts/submit-ios.mjs --latest
//   node scripts/submit-ios.mjs --build <eas-build-id>
//   node scripts/submit-ios.mjs --path ./self-sown-vendor.ipa
//
// Env: EXPO_TOKEN (downloads the EAS artifact) and EAS_PROJECT_ID.
// EAS_CLI_BIN overrides the EAS executable (used by tests with a stub).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { verifyIosEntitlements } from "./verify-ios-entitlements.mjs";

const EAS_PROJECT_ID =
  process.env.EAS_PROJECT_ID ?? "0b827bc9-9288-4747-b7d3-b811bb384860";

// Default is `npx eas-cli <args>`; EAS_CLI_BIN points straight at a real or
// stubbed EAS executable (no `eas-cli` subcommand in that case).
const EAS_CLI_BIN = process.env.EAS_CLI_BIN;
function eas(args, opts = {}) {
  const command = EAS_CLI_BIN ?? "npx";
  const base = EAS_CLI_BIN ? [] : ["eas-cli"];
  return execFileSync(command, [...base, ...args], {
    encoding: "utf8",
    env: { ...process.env, EAS_PROJECT_ID },
    stdio: ["ignore", "pipe", "inherit"],
    ...opts,
  });
}

function parseArgs(argv) {
  const opts = { profile: "production", latest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // pnpm/npm forward a bare `--` separator through to the script; ignore it.
    if (arg === "--") continue;
    if (arg === "--latest") opts.latest = true;
    else if (arg === "--path") opts.path = argv[++i];
    else if (arg === "--build") opts.build = argv[++i];
    else if (arg === "--profile") opts.profile = argv[++i];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

function resolveBuildId(opts) {
  if (opts.build) return opts.build;
  if (!opts.latest) return null;
  const list = JSON.parse(
    eas([
      "build:list",
      "--platform",
      "ios",
      "--build-profile",
      opts.profile,
      "--status",
      "finished",
      "--limit",
      "1",
      "--json",
      "--non-interactive",
    ])
  );
  if (!list.length)
    throw new Error(`no finished iOS ${opts.profile} build found on EAS`);
  return list[0].id;
}

async function downloadIpa(buildId) {
  const build = JSON.parse(eas(["build:view", buildId, "--json"]));
  if (build.status !== "FINISHED")
    throw new Error(`build ${buildId} is ${build.status}, not FINISHED`);
  const url =
    build.artifacts?.applicationArchiveUrl ?? build.artifacts?.buildUrl;
  if (!url) throw new Error(`build ${buildId} has no downloadable IPA artifact`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.EXPO_TOKEN ?? ""}` },
    redirect: "follow",
  });
  if (!res.ok)
    throw new Error(
      `artifact download failed: ${res.status} (is EXPO_TOKEN set?)`
    );
  const dir = mkdtempSync(path.join(tmpdir(), "ttp-ipa-"));
  const file = path.join(dir, "app.ipa");
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log(`downloaded ${buildId} \u2192 ${file}`);
  return { file, dir };
}

const opts = parseArgs(process.argv.slice(2));

async function main() {
  let ipaPath = opts.path;
  let cleanupDir = null;
  if (!ipaPath) {
    const buildId = resolveBuildId(opts);
    if (!buildId)
      throw new Error("pass --path <ipa>, --build <eas-build-id>, or --latest");
    const downloaded = await downloadIpa(buildId);
    ipaPath = downloaded.file;
    cleanupDir = downloaded.dir;
  }

  try {
    // The gate: a build that lost the entitlement must never reach anything Apple
    // can review. verifyIosEntitlements throws loudly on failure.
    const parsed = verifyIosEntitlements(ipaPath);
    console.log(
      `Tap to Pay entitlement present (aps-environment=${parsed.apsEnvironment}) \u2014 proceeding to submit`
    );

    eas([
      "submit",
      "--platform",
      "ios",
      "--profile",
      opts.profile,
      "--path",
      ipaPath,
      "--non-interactive",
    ], { stdio: "inherit" });
  } finally {
    if (cleanupDir) rmSync(cleanupDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n\u2717 Refusing to submit \u2014 ${error.message}\n`);
  process.exit(1);
});
