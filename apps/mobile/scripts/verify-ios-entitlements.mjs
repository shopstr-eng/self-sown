// Pre-submission guard for the Tap to Pay entitlement in a built iOS IPA (or a
// bare .app bundle). Apple's proximity-reader entitlement can silently drop out
// of a fresh provisioning profile that was created after the capability was
// enabled (it is not toggleable via the ASC API), and a profile that forgot it
// still signs and validates — the build only fails later, in App Review.
//
// So: unzip the IPA, decode its embedded.mobileprovision (a CMS-signed plist),
// and assert BOTH of the App Store signing invariants before submission:
//   1. com.apple.developer.proximity-reader.payment.acceptance is present (true)
//   2. aps-environment == "production"
// Exit non-zero and print loudly on any failure.
//
// Usage:
//   node scripts/verify-ios-entitlements.mjs <path.ipa | path.app | path.mobileprovision> [...]
//   (defaults to the most recent .ipa under the CWD when no path is given)
//
// Exported helpers are reused by scripts/submit-ios.mjs so this check cannot be
// skipped by going around the CLI.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROXIMITY_READER_ENTITLEMENT =
  "com.apple.developer.proximity-reader.payment.acceptance";
export const REQUIRED_APS_ENVIRONMENT = "production";

// Decode a binary CMS-signed .mobileprovision into its XML plist text. Apple's
// file is a PKCS#7 SignedData whose encapsulated content is the plist; openssl
// extracts it without needing a Mac (`security cms -D` equivalent).
function decodeMobileProvision(provisionBytes) {
  const dir = mkdtempSync(path.join(tmpdir(), "ttp-profile-"));
  const file = path.join(dir, "profile.mobileprovision");
  try {
    writeFileSync(file, provisionBytes);
    let raw;
    try {
      // -noverify: we are inspecting entitlements, not validating Apple's chain.
      raw = execFileSync(
        "openssl",
        ["smime", "-inform", "der", "-verify", "-noverify", "-in", file],
        { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }
      );
    } catch (error) {
      const detail = (error.stderr || error.message || "").toString().trim();
      throw new Error(
        `could not decode embedded.mobileprovision as a CMS-signed plist: ${detail}`
      );
    }
    const start = raw.indexOf("<?xml");
    const end = raw.lastIndexOf("</plist>");
    if (start === -1 || end === -1)
      throw new Error(
        "decoded mobileprovision has no plist payload (unexpected format)"
      );
    return raw.slice(start, end + "</plist>".length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Return the raw XML of the value that follows `key` at the top level of the
// plist. Handles bool/string scalars and balanced <dict>/<array> blocks so we
// never match a key inside a nested dict by accident.
function extractPlistValue(plistXml, key) {
  const marker = `<key>${key}</key>`;
  const at = plistXml.indexOf(marker);
  if (at === -1) return null;
  const after = plistXml.slice(at + marker.length);
  const tagStart = after.search(/<[a-z]/);
  if (tagStart === -1) return null;
  const rest = after.slice(tagStart);
  const openTag = /^<([a-z]+)\s*(\/)?>/.exec(rest);
  if (!openTag) return null;
  const tag = openTag[1];
  // Self-closing value, e.g. <true/> or <false/>.
  if (openTag[2]) return `<${tag}/>`;
  if (tag === "dict" || tag === "array") {
    let depth = 0;
    const re = new RegExp(`</?${tag}>`, "g");
    let match;
    while ((match = re.exec(rest))) {
      depth += match[0][1] === "/" ? -1 : 1;
      if (depth === 0) return rest.slice(0, match.index + match[0].length);
    }
    return null;
  }
  const closeTag = `</${tag}>`;
  const closeAt = rest.indexOf(closeTag);
  if (closeAt === -1) return null;
  return rest.slice(0, closeAt + closeTag.length);
}

// Pull the signing facts we care about out of a decoded provisioning profile.
export function parseMobileProvision(plistXml) {
  const entitlementsBlock = extractPlistValue(plistXml, "Entitlements");
  if (!entitlementsBlock)
    throw new Error("provisioning profile has no Entitlements dictionary");

  const scalar = (key) => {
    const block = extractPlistValue(entitlementsBlock, key);
    if (block === null) return undefined;
    const text = /<(string|integer|real)>([\s\S]*?)<\/\1>/.exec(block);
    if (text) return text[2];
    if (/<true\s*\/>/.test(block)) return true;
    if (/<false\s*\/>/.test(block)) return false;
    return block;
  };

  const appIdMatch = /<key>application-identifier<\/key>\s*<string>([^<]*)<\/string>/.exec(
    entitlementsBlock
  );
  return {
    proximityReader: scalar(PROXIMITY_READER_ENTITLEMENT),
    apsEnvironment: scalar("aps-environment"),
    getTaskAllow: scalar("get-task-allow"),
    applicationIdentifier: appIdMatch ? appIdMatch[1] : undefined,
  };
}

// Assert the App Store signing invariants. Returns the parsed profile on
// success; throws a descriptive Error on failure.
export function assertAppStoreEntitlements(plistXml, { source } = {}) {
  const parsed = parseMobileProvision(plistXml);
  const where = source ? ` (${source})` : "";

  if (parsed.proximityReader !== true) {
    throw new Error(
      `missing the Tap to Pay entitlement "${PROXIMITY_READER_ENTITLEMENT}"${where} ` +
        `(found: ${JSON.stringify(parsed.proximityReader) ?? "undefined"}). ` +
        "App Review will reject this build; regenerate the App Store provisioning profile " +
        "with the capability enabled (see scripts/regen-ios-provisioning-profile.mjs)."
    );
  }
  if (parsed.apsEnvironment !== REQUIRED_APS_ENVIRONMENT) {
    throw new Error(
      `aps-environment is ${JSON.stringify(parsed.apsEnvironment) ?? "undefined"}, ` +
        `expected "${REQUIRED_APS_ENVIRONMENT}"${where}. ` +
        "This is not a production App Store profile — push notifications would silently " +
        "fail on the submitted build."
    );
  }
  return parsed;
}

function findProvisionBytes(target) {
  if (target.endsWith(".mobileprovision")) {
    return { bytes: readFileSync(target), source: target };
  }
  if (path.extname(target) === ".ipa" || target.endsWith(".ipa")) {
    let bytes;
    try {
      bytes = execFileSync(
        "unzip",
        ["-p", target, "Payload/*.app/embedded.mobileprovision"],
        { maxBuffer: 32 * 1024 * 1024 }
      );
    } catch (error) {
      throw new Error(
        `could not read Payload/*.app/embedded.mobileprovision from ${target}: ` +
          `${(error.stderr || error.message || "").toString().trim()}`
      );
    }
    if (!bytes || bytes.length === 0)
      throw new Error(`no embedded.mobileprovision inside ${target}`);
    return { bytes, source: `${target}!Payload/*.app/embedded.mobileprovision` };
  }
  if (existsSync(path.join(target, "embedded.mobileprovision"))) {
    const file = path.join(target, "embedded.mobileprovision");
    return { bytes: readFileSync(file), source: file };
  }
  throw new Error(
    `unsupported target "${target}" — pass an .ipa, an .app directory, or an embedded.mobileprovision`
  );
}

// Verify a single IPA/.app/.mobileprovision target. Throws on failure.
export function verifyIosEntitlements(target) {
  const { bytes, source } = findProvisionBytes(target);
  const plistXml = decodeMobileProvision(bytes);
  return assertAppStoreEntitlements(plistXml, { source });
}

function resolveTargets(argv) {
  const explicit = argv.filter((arg) => !arg.startsWith("-"));
  if (explicit.length > 0) return explicit;
  const ipas = readdirSync(process.cwd()).filter((name) => name.endsWith(".ipa"));
  if (ipas.length === 1) return [path.resolve(process.cwd(), ipas[0])];
  throw new Error(
    "no IPA path given and no single .ipa in the current directory; " +
      "usage: node scripts/verify-ios-entitlements.mjs <path.ipa | path.app | path.mobileprovision>"
  );
}

function main() {
  const targets = resolveTargets(process.argv.slice(2));
  for (const target of targets) {
    const parsed = verifyIosEntitlements(target);
    console.log(
      `✓ ${target}\n` +
        `    proximity-reader: ${PROXIMITY_READER_ENTITLEMENT} = true\n` +
        `    aps-environment: ${parsed.apsEnvironment}\n` +
        `    application-identifier: ${parsed.applicationIdentifier ?? "(none)"}`
    );
  }
  console.log(
    `\nApp Store entitlements verified for ${targets.length} target(s).`
  );
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    console.error(
      `\n✗ Refusing to proceed — Tap to Pay entitlement check failed:\n  ${error.message}\n`
    );
    process.exit(1);
  }
}
