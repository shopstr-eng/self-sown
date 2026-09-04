---
name: Agent bash sandbox gotchas (pkill self-kill, long builds)
description: Two recurring traps when driving the bash tool — pkill kills the agent's own shell, and long builds need detaching from the 2-min cap and the workflow port-wait.
---

# Agent bash sandbox gotchas

## `pkill -f <pattern>` kills the agent's OWN shell

Every bash command that ran `pkill -f '<pattern>'` exited 143 (SIGTERM) with no
output — even when the pattern (e.g. `next build`, `pnpm run dev`) did not
literally appear in my command. Commands without pkill ran fine and produced
output.
**Why:** the bash tool's shell shares a process group / supervisor with the
targets, so the signal cascades back to the running command and kills it before
any later line executes.
**How to apply:** do NOT use `pkill`/`killall` from the bash tool. To stop a
workflow process use the workflow tooling; to find a stray pid use `ps`/`pgrep`
and kill that exact pid only if truly necessary.

## Running a build longer than the 2-min bash cap

The bash tool caps at 120s, too short for a cold Next/Turbopack build. Configuring
the build as a `waitForPort` workflow does NOT help either: the harness kills the
whole process group when the port doesn't open within its short wait window, so
the build dies mid-compile.
**How to apply:** launch the build fully detached and poll its log:
`setsid bash -c "next build > /tmp/b.log 2>&1; echo EXIT=\$? >> /tmp/b.log" </dev/null >/dev/null 2>&1 &`
then `sleep` + `tail /tmp/b.log` across turns. If memory drops sharply and the
log freezes at "Creating an optimized production build" with no EXIT marker, the
kernel OOM-killer reaped it — that is the documented cold-build OOM (see
upstream-parity-and-dev-oom.md), not a code regression. Verify via tsc+lint+jest
instead and note the boot limitation.

## `tsc --noEmit`: background ShellExec task works; detached `setsid` does not

Full-project `tsc --noEmit` on this large Next 16 repo completes in ~2-4 min when
started as a **background ShellExec task** (`run_in_background: true` with output
redirected to a file + a Monitor on an `EXIT:` marker). What fails is a manually
`setsid`-detached process: it is reaped across bash tool-call boundaries (log stays
0 bytes with no EXIT marker — not an OOM, the process is simply gone, so you poll
forever).
**How to apply:** for a full-graph type check, use a background ShellExec task
(`NODE_OPTIONS='--max-old-space-size=3072' npx tsc --noEmit --incremental false`),
NOT setsid. For a quick post-edit check of a few touched files, the diagnostics
skill's `getLatestLspDiagnostics({filePath})` is faster — the `tsserver` LSP is
already running. Don't run Jest concurrently with tsc (memory contention).

**Caveat — empty LSP diagnostics can be a false clean.** `getLatestLspDiagnostics`
returned `{diagnostics:{}}` for files that genuinely had missing imports and
out-of-scope identifiers (tsserver hadn't analyzed those files; empty means "no
data", not "no errors") — and on a newly CREATED test file it returned clean
while full tsc found 22 errors in it (SWC-based jest strips types without
checking, so green tests prove nothing about types either). For new files, and
before any review/commit gate, only the full typecheck workflow / background
tsc run is authoritative. After a multi-file refactor, back the LSP check with
a cheap structural audit: grep each touched file for the symbols it uses vs.
what it imports, and node-parse function param destructures for props you pass
(e.g. `colors={colors}` with no `colors` in the signature). External code
review caught what LSP missed.

`pgrep -f "tsserver.js"` also matches your OWN wrapper shell's command line (bash -c "...tsserver.js..."), so `kill $(pgrep -f tsserver.js)` kills your own shell mid-command (exit -1). Anchor the pattern to the process start instead: `pgrep -f "^/nix/store.*tsserver.js" | xargs -r kill`, or kill listed PIDs excluding $$.

## Long-lived local services (e.g. a Nutshell mint) must be managed workflows

Background shell tasks auto-stop after ~5 minutes and detached `setsid`
processes get reaped across tool-call boundaries (see the tsc note above), so a
local service started either way silently dies mid-test. For the staging escrow
runs the local Nutshell mint only survived as a configured workflow
("Staging Cashu Mint", port 3338, FakeWallet, MINT_RATE_LIMIT=FALSE).
**How to apply:** anything that must stay up longer than one bash call — mints,
relays, mock servers — goes through the workflows tooling, not a background
shell.
