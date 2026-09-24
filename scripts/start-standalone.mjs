#!/usr/bin/env node
// `pnpm start`: boots the production server.
//
// The app is built with `output: "standalone"`, where `next start` is NOT
// supported (Next prints '"next start" does not work with "output: standalone"'
// today and may hard-fail on a future upgrade). The supported entry point is
// the standalone server, so this script prepares the bundle (static/public
// assets + Sharp natives) and execs it. Honors PORT (default 3000) and
// HOSTNAME (default 0.0.0.0), matching the old `next start -H 0.0.0.0 -p`
// flags.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = process.cwd();
const serverPath = path.join(root, ".next", "standalone", "server.js");
// The sibling prepare script ships alongside this one — resolve it from this
// file's location, not the caller's cwd.
const preparePath = fileURLToPath(
  new URL("./prepare-standalone.mjs", import.meta.url)
);

if (!fs.existsSync(serverPath)) {
  console.error(
    '[start] No standalone build found at .next/standalone/server.js — run "pnpm build" first.'
  );
  process.exit(1);
}

const prepare = spawnSync(process.execPath, [preparePath], {
  stdio: "inherit",
  cwd: root,
});
if (prepare.status !== 0) {
  process.exit(prepare.status ?? 1);
}

process.env.HOSTNAME ||= "0.0.0.0";
process.env.PORT ||= "3000";

const child = spawn(process.execPath, [serverPath], {
  stdio: "inherit",
  env: process.env,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    child.kill(signal);
  });
}

child.on("exit", (code, signal) => {
  if (signal) {
    // Mirror the child's signal death so `pnpm start` propagates it. The
    // forwarding handlers above must be removed FIRST: while installed they
    // intercept the re-raised signal, and the wrapper would then exit
    // naturally (status 0) instead of dying by the signal, breaking the
    // shutdown status service managers rely on. With no listener, Node
    // restores the default disposition (terminate).
    for (const s of ["SIGINT", "SIGTERM"]) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
