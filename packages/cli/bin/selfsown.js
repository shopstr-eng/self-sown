#!/usr/bin/env node
// Thin ESM launcher: all logic lives in ../dist/cli.js (compiled from src/cli.ts)
// so the published bin never depends on import-meta detection or ts-node.
import { main } from "../dist/cli.js";

// process.exit() can truncate buffered stdout — set exitCode and let the
// process exit naturally so large JSON payloads drain fully.
process.exitCode = await main(process.argv.slice(2));
