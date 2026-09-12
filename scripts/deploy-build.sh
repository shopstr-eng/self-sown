#!/usr/bin/env bash
# Deployment build script for Replit Autoscale.
#
# Produces a Next.js standalone bundle. Autoscale provides its own Node.js
# runtime via the `nodejs-22` Nix module declared in .replit, so we do NOT
# bundle a custom Node binary. We also preserve all top-level config files
# (.replit, replit.nix, package.json, pnpm-lock.yaml) that Autoscale needs
# to boot the app.

set -e

echo "==> Pre-build cleanup (remove dev artifacts that bloat the image)"
rm -rf \
  .next \
  .cache \
  cache \
  .swc \
  .turbo \
  .pnpm-store \
  node_modules \
  packages/*/node_modules \
  apps/*/node_modules \
  apps/mobile \
  coverage \
  "$HOME/.cache" \
  "$HOME/.pnpm-store" \
  "$HOME/.local/share/pnpm" \
  "${TMPDIR:-/tmp}"/* 2>/dev/null || true

echo "==> Installing production deps (web only)"
pnpm install \
  --frozen-lockfile \
  --prefer-offline \
  --filter=self-sown... \
  --filter='!@self-sown/mobile'

echo "==> Verifying stylesheet compiles with all UI marker styles"
# Fails the publish loudly if a Tailwind @source glob into node_modules
# silently matches nothing (e.g. a scanned package that fresh pnpm installs
# don't materialize) — the failure mode that once shipped a stylesheet
# missing ~880 HeroUI component classes while builds stayed green.
node scripts/check-globals-css.mjs > /dev/null

echo "==> Building Next.js (standalone output)"
next build

echo "==> Folding static + public into the standalone bundle"
# Shared with `pnpm start` (scripts/start-standalone.mjs). --strict-sharp keeps
# the deploy build failing loudly if the Sharp native repair can't run.
node scripts/prepare-standalone.mjs --strict-sharp

echo "==> Post-build cleanup (drop only large, runtime-irrelevant items)"
# IMPORTANT: do NOT remove .replit, replit.nix, package.json, pnpm-lock.yaml,
# .nvmrc, or .node-version. Autoscale needs them to boot the app.
# The standalone bundle ships its own node_modules under
# .next/standalone/node_modules, so the top-level node_modules can go.
rm -rf \
  node_modules \
  packages/*/node_modules \
  apps/*/node_modules \
  apps \
  packages \
  components \
  pages \
  utils \
  styles \
  db \
  mcp \
  proxy.ts \
  instrumentation.ts \
  __tests__ \
  coverage \
  .git \
  .github \
  .husky \
  .agents \
  .local \
  .upm \
  .swc \
  .cache \
  cache \
  .turbo \
  .pnpm-store \
  attached_assets \
  docs \
  tsconfig.tsbuildinfo \
  jest.config.cjs \
  jest.setup.js \
  eslint.config.mjs \
  .eslintrc.json \
  .eslintrc.security.js \
  .prettierrc \
  .prettierignore \
  Dockerfile \
  docker-compose.yml \
  .dockerignore \
  README.md \
  CONTRIBUTING.md \
  LICENSE \
  replit.md \
  threat_model.md \
  public \
  2>/dev/null || true

# Inside .next, only the standalone bundle is needed at runtime.
node -e "
  const fs = require('fs');
  const path = require('path');
  if (fs.existsSync('.next')) {
    for (const f of fs.readdirSync('.next')) {
      if (f !== 'standalone') fs.rmSync(path.join('.next', f), { recursive: true, force: true });
    }
  }
"

echo "==> Bundling portable Node 22 binary for runtime"
# Autoscale's runtime container ships an older `node` on PATH (observed
# v18.12.1). Next.js 16 needs Node 22+ for AsyncLocalStorage.snapshot(), so
# we ship a portable Node 22 binary alongside the bundle. We download the
# official portable build (linux-x64) instead of copying from the Nix store
# because Nix binaries depend on a custom dynamic linker
# (/nix/store/...-glibc/lib/ld-linux-x86-64.so.2) that does not exist in the
# autoscale runtime container.
NODE_VERSION="v22.22.0"
NODE_DIST="node-${NODE_VERSION}-linux-x64"
# Pinned SHA-256 of ${NODE_DIST}.tar.xz, from
# https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt — update together
# with NODE_VERSION. The pin (not the fetched checksum file) is the source of
# truth, so a tampered download server can't substitute both the tarball and
# its checksum. NODE_TARBALL_SHA256 overrides the pin for the test sandbox.
NODE_SHA256="${NODE_TARBALL_SHA256:-9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37}"
mkdir -p .runtime
if [ ! -x ".runtime/bin/node" ]; then
  curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/${NODE_DIST}.tar.xz" -o /tmp/node.tar.xz
  echo "==> Verifying Node ${NODE_VERSION} tarball checksum"
  # Cross-check the pin against the official checksum file so a stale pin is
  # caught loudly at version-bump time instead of misreporting tampering.
  PUBLISHED_SHA256="$(curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" | awk -v f="${NODE_DIST}.tar.xz" '$2 == f {print $1}')"
  if [ -z "$PUBLISHED_SHA256" ]; then
    echo "ERROR: ${NODE_DIST}.tar.xz not found in nodejs.org SHASUMS256.txt for ${NODE_VERSION}" >&2
    exit 1
  fi
  if [ "$NODE_SHA256" != "$PUBLISHED_SHA256" ]; then
    echo "ERROR: pinned Node checksum does not match nodejs.org SHASUMS256.txt — update NODE_SHA256 together with NODE_VERSION" >&2
    exit 1
  fi
  ACTUAL_SHA256="$(sha256sum /tmp/node.tar.xz | awk '{print $1}')"
  if [ "$ACTUAL_SHA256" != "$NODE_SHA256" ]; then
    echo "ERROR: Node tarball checksum mismatch (expected $NODE_SHA256, got $ACTUAL_SHA256) — refusing to bundle a corrupted or tampered download" >&2
    exit 1
  fi
  tar -xJf /tmp/node.tar.xz -C /tmp
  mkdir -p .runtime/bin
  cp "/tmp/${NODE_DIST}/bin/node" .runtime/bin/node
  chmod +x .runtime/bin/node
  rm -rf "/tmp/${NODE_DIST}" /tmp/node.tar.xz
fi
echo "    bundled $(./.runtime/bin/node --version) (portable, glibc-compatible)"

echo "==> Final size:"
du -sh . .next .next/standalone .runtime 2>/dev/null || true
echo "==> Top-level files preserved:"
ls -la | head -30
