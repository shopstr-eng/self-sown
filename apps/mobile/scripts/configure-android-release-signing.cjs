const fs = require("node:fs");

const SIGNING_MARKER = "// SELF-SOWN-RELEASE-SIGNING";
const SIGNING_ENV = [
  "ANDROID_KEYSTORE_FILE",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

function findMatchingBrace(source, openIndex) {
  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "{") depth += 1;
    if (character === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  throw new Error(
    "Could not find the closing brace in the generated Gradle file."
  );
}

function findNamedBlock(
  source,
  name,
  rangeStart = 0,
  rangeEnd = source.length
) {
  const pattern = new RegExp(`\\b${name}\\s*\\{`, "g");
  pattern.lastIndex = rangeStart;

  let match = pattern.exec(source);
  while (match && match.index < rangeEnd) {
    const lineStart = source.lastIndexOf("\n", match.index - 1) + 1;
    if (!source.slice(lineStart, match.index).trim().startsWith("//")) {
      const openIndex = source.indexOf("{", match.index);
      const closeIndex = findMatchingBrace(source, openIndex);
      if (closeIndex < rangeEnd) {
        return { start: match.index, openIndex, closeIndex };
      }
    }
    match = pattern.exec(source);
  }

  throw new Error(
    `Could not find the ${name} block in the generated Gradle file.`
  );
}

function configureAndroidReleaseSigning(source) {
  if (source.includes(SIGNING_MARKER)) return source;

  const androidBlock = findNamedBlock(source, "android");
  const signingConfigs = findNamedBlock(
    source,
    "signingConfigs",
    androidBlock.openIndex + 1,
    androidBlock.closeIndex
  );
  const signingContents = source.slice(
    signingConfigs.openIndex + 1,
    signingConfigs.closeIndex
  );
  if (/\brelease\s*\{/.test(signingContents)) {
    throw new Error(
      "Generated signingConfigs already contains a release block; review the Expo template before building."
    );
  }

  const buildTypes = findNamedBlock(
    source,
    "buildTypes",
    androidBlock.openIndex + 1,
    androidBlock.closeIndex
  );
  const releaseBuildType = findNamedBlock(
    source,
    "release",
    buildTypes.openIndex + 1,
    buildTypes.closeIndex
  );
  const releaseContents = source.slice(
    releaseBuildType.openIndex + 1,
    releaseBuildType.closeIndex
  );
  const debugSigning = releaseContents.match(
    /^\s*signingConfig\s+signingConfigs\.debug\s*$/gm
  );
  if (debugSigning?.length !== 1) {
    throw new Error(
      "Expected one debug signingConfig in the release build type; review the Expo template before building."
    );
  }

  const signingLineStart =
    source.lastIndexOf("\n", signingConfigs.start - 1) + 1;
  const baseIndent =
    source.slice(signingLineStart, signingConfigs.start).match(/^\s*/)?.[0] ??
    "";
  const innerIndent = `${baseIndent}    `;
  const signingConfig = [
    "",
    `${innerIndent}${SIGNING_MARKER}`,
    `${innerIndent}release {`,
    `${innerIndent}    storeFile file(System.getenv("ANDROID_KEYSTORE_FILE"))`,
    `${innerIndent}    storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD")`,
    `${innerIndent}    keyAlias System.getenv("ANDROID_KEY_ALIAS")`,
    `${innerIndent}    keyPassword System.getenv("ANDROID_KEY_PASSWORD")`,
    `${innerIndent}}`,
  ].join("\n");

  let configured = `${source.slice(0, signingConfigs.closeIndex)}${signingConfig}\n${source.slice(signingConfigs.closeIndex)}`;
  const adjustedBuildTypes = findNamedBlock(
    configured,
    "buildTypes",
    androidBlock.openIndex + 1,
    androidBlock.closeIndex + signingConfig.length
  );
  const adjustedRelease = findNamedBlock(
    configured,
    "release",
    adjustedBuildTypes.openIndex + 1,
    adjustedBuildTypes.closeIndex
  );
  const updatedReleaseContents = configured
    .slice(adjustedRelease.openIndex + 1, adjustedRelease.closeIndex)
    .replace(
      /^(\s*)signingConfig\s+signingConfigs\.debug\s*$/m,
      "$1signingConfig signingConfigs.release"
    );
  configured = [
    configured.slice(0, adjustedRelease.openIndex + 1),
    updatedReleaseContents,
    configured.slice(adjustedRelease.closeIndex),
  ].join("");

  return configured;
}

function main() {
  for (const name of SIGNING_ENV) {
    if (!process.env[name]) {
      throw new Error(
        `Missing required Android signing environment variable: ${name}`
      );
    }
  }

  const gradlePath = process.argv[2] ?? "apps/mobile/android/app/build.gradle";
  if (!fs.existsSync(gradlePath)) {
    throw new Error(`Generated Android Gradle file not found: ${gradlePath}`);
  }

  const current = fs.readFileSync(gradlePath, "utf8");
  const updated = configureAndroidReleaseSigning(current);
  fs.writeFileSync(gradlePath, updated);
  console.log(
    "Configured generated Android release signing without writing key material into the project."
  );
}

if (require.main === module) main();

module.exports = { configureAndroidReleaseSigning };
