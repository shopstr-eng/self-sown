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

## `tsc --noEmit` is unreliable + very slow here — prefer LSP diagnostics

Full-project `tsc --noEmit` on this large Next 16 repo is pathologically slow on a
throttled box (12+ min, sometimes never completing), AND the detached process is
reaped across bash tool-call boundaries even with `setsid … </dev/null >/dev/null 2>&1 &`
(log stays 0 bytes with no EXIT marker — not an OOM, the process is simply gone,
so you poll forever).
**How to apply:** for a post-edit type check, don't fight full tsc. Use the
diagnostics skill's `getLatestLspDiagnostics({filePath})` per touched file — the
`tsserver` LSP is already running, so it returns type errors for those exact files
in seconds. Reserve full tsc for when you truly need whole-graph checking and can
babysit it in the foreground.

**Caveat — empty LSP diagnostics can be a false clean.** `getLatestLspDiagnostics`
returned `{diagnostics:{}}` for files that genuinely had missing imports and
out-of-scope identifiers (tsserver hadn't analyzed those files; empty means "no
data", not "no errors"). After a multi-file refactor, back the LSP check with a
cheap structural audit: grep each touched file for the symbols it uses vs. what
it imports, and node-parse function param destructures for props you pass (e.g.
`colors={colors}` with no `colors` in the signature). External code review caught
what LSP missed.
