import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Repairs the Sharp native packages inside .next/standalone: pnpm's tracing can
// omit the @img/* native binaries (sharp-linux-x64, sharp-libvips-linux-x64)
// from the standalone bundle even when the build is green. Exported so
// scripts/prepare-standalone.mjs can reuse it; also runnable directly (CLI
// behavior at the bottom) — deploy/dev scripts rely on a non-zero exit when
// the repair cannot be completed.
export function repairSharpStandalone(rootDir = process.cwd()) {
  const pnpmRoot = path.join(rootDir, ".next/standalone/node_modules/.pnpm");
  const workspacePnpmRoot = path.join(rootDir, "node_modules/.pnpm");
  const hoistedImgRoot = path.join(rootDir, "node_modules/@img");
  const nativePackages = ["sharp-linux-x64", "sharp-libvips-linux-x64"];

  if (!fs.existsSync(pnpmRoot)) {
    throw new Error("Standalone bundle is missing its Sharp package");
  }

  const sharpEntries = fs
    .readdirSync(pnpmRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("sharp@"));

  if (sharpEntries.length === 0) {
    throw new Error("Standalone bundle is missing its Sharp package");
  }

  // The root node_modules/@img hoist is an artifact of the platform's
  // pre-build `npm install` and is not guaranteed to survive the production
  // `pnpm install --prod` (deploy build 2026-09-03 failed on exactly that).
  // The location pnpm always populates is the @img directory pnpm links into
  // the sharp package's own .pnpm context, so resolve from there first.
  function resolveNativeSource(sharpEntryName, packageName) {
    const candidates = [
      path.join(
        workspacePnpmRoot,
        sharpEntryName,
        "node_modules",
        "@img",
        packageName
      ),
      path.join(hoistedImgRoot, packageName),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    throw new Error(
      `Sharp native package ${packageName} not found for ${sharpEntryName} ` +
        `(looked in: ${candidates.join(", ")})`
    );
  }

  for (const { name } of sharpEntries) {
    const packageRoot = path.join(pnpmRoot, name, "node_modules", "@img");
    fs.mkdirSync(packageRoot, { recursive: true });

    for (const packageName of nativePackages) {
      const source = resolveNativeSource(name, packageName);
      const destination = path.join(packageRoot, packageName);
      fs.rmSync(destination, { recursive: true, force: true });
      fs.cpSync(source, destination, { recursive: true, dereference: true });
    }
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  try {
    repairSharpStandalone();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
