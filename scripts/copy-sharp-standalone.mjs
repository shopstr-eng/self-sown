import fs from "node:fs";
import path from "node:path";

const sourceRoot = path.resolve("node_modules/@img");
const pnpmRoot = path.resolve(".next/standalone/node_modules/.pnpm");
const nativePackages = [
  "sharp-linux-x64",
  "sharp-libvips-linux-x64",
];

const sharpEntries = fs
  .readdirSync(pnpmRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("sharp@"));

if (sharpEntries.length === 0) {
  throw new Error("Standalone bundle is missing its Sharp package");
}

for (const { name } of sharpEntries) {
  const packageRoot = path.join(pnpmRoot, name, "node_modules", "@img");
  fs.mkdirSync(packageRoot, { recursive: true });

  for (const packageName of nativePackages) {
    const source = path.join(sourceRoot, packageName);
    const destination = path.join(packageRoot, packageName);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.cpSync(source, destination, { recursive: true, dereference: true });
  }
}