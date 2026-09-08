// Build from an isolated source snapshot. Generated native files stay out of git.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const target = mkdtempSync(join(tmpdir(), "milk-native-"));
const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  if (
    file.startsWith(".codex/") ||
    file.startsWith(".agents/") ||
    file.startsWith(".env") ||
    !existsSync(join(root, file))
  )
    continue;
  mkdirSync(dirname(join(target, file)), { recursive: true });
  copyFileSync(join(root, file), join(target, file));
}
for (const directory of [
  "",
  "apps/mobile",
  "packages/domain",
  "packages/api-client",
  "packages/nostr",
]) {
  const source = join(root, directory, "node_modules");
  if (existsSync(source))
    symlinkSync(source, join(target, directory, "node_modules"), "dir");
}
// Metro must watch the real dependency targets, not only their symlinks.
const metroPath = join(target, "apps/mobile/metro.config.js");
writeFileSync(
  metroPath,
  readFileSync(metroPath, "utf8") +
    `
module.exports.watchFolders = [...module.exports.watchFolders, ${JSON.stringify(root)}];
`
);
const platform = process.argv[2] ?? "ios";
if (!["ios", "android"].includes(platform))
  throw new Error("Choose ios or android.");
if (process.argv.includes("--fixtures")) {
  copyFileSync(
    join(root, "scripts/mobile/local-entry.cjs"),
    join(target, "apps/mobile/index.js")
  );
  const configPath = join(target, "apps/mobile/app.config.ts");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(
      "export default config;",
      `config.ios={...config.ios,bundleIdentifier:"com.milkmarket.mobile.local"};
config.android={...config.android,package:"com.milkmarket.mobile.local"};
export default config;`
    )
  );
}
execFileSync(
  "pnpm",
  ["exec", "expo", "prebuild", "--platform", platform, "--no-install"],
  {
    cwd: join(target, "apps/mobile"),
    stdio: "inherit",
    env: { ...process.env, MOBILE_APP_VARIANT: "development" },
  }
);
console.log(`NATIVE_WORKSPACE=${target}`);
