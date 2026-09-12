---
name: Editing .replit requires verifyAndReplaceDotReplit
description: Direct Edit/WriteFile on .replit is blocked; write full TOML to a temp file and call the verifyAndReplaceDotReplit CodeExecution callback.
---

Direct edits to `.replit` (and `replit.nix`) are rejected by the Edit tool. The required flow:

1. Read the full `.replit` (watch for huge env-var blobs that truncate shell output — read via the file tools, not cat).
2. Write the complete updated TOML to a temp file inside the workspace (e.g. `.replit.new`).
3. Call `verifyAndReplaceDotReplit({ tempFilePath })` in CodeExecution — it schema-validates, replaces `.replit`, and removes the temp file.

**Why:** the platform schema-validates `.replit` changes before applying them; bypassing the callback is not possible.

**How to apply:** any change to run commands, the `[deployment]` build/run commands, ports, or workflow definitions in `.replit`.
