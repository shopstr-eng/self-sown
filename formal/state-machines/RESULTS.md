# State-machine check results

Run date: 2026-11-23. Scope, source owners, model limitations and findings:
[`docs/state-machines.md`](../../docs/state-machines.md).

## TLC

### Current remediation results

The corrected protocol passed **all eight bounded models and both retained
regression configurations**. Both previously failing properties now pass.
The escrow model no longer relies on `ProtectSpentConversion`.

| Model/config | Generated | Distinct | Depth | Current result |
|---|---:|---:|---:|---|
| UcpCheckout | 70 | 25 | 6 | Pass |
| CashuEscrowOutbox | 476 | 159 | 12 | Pass |
| SellerOrder | 6 | 6 | 4 | Pass |
| CustomDomain | 5 | 4 | 3 | Pass |
| ScheduledBlog | 70 | 38 | 10 | Pass |
| ProMembership | 20 | 7 | 5 | Pass |
| MobilePushDelivery | 40 | 20 | 5 | Pass |
| OAuthHandoff | 22 | 14 | 5 | Pass |
| UcpCheckoutRetryRace | 70 | 25 | 6 | Pass |
| CashuEscrowExpiryRecovery | 476 | 159 | 12 | Pass |

The original nine configs ran together; the newly added OAuth model ran in a
second isolated invocation. Reproduce all ten with the current runner documented
in `docs/state-machines.md`. Tool: official TLA+ **v1.7.4**, TLC2 2.19
(08 August 2024, revision 5a47802), GraalVM Java 19. Source:
https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar

Pinned SHA-256:
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`.
Execution used a no-network, empty-project-environment sandbox with read-only
source/toolchains, bounded scratch and resource limits.

Implementation evidence includes **real PostgreSQL** concurrent retry tests for
all four settlement outcomes, including subscriptions without an MCP order id.
A controlled mint adapter plus real PostgreSQL reproduced the retired expiry
conversion's data loss inside a rolled-back transaction, then demonstrated
recovery after a post-swap finalization failure without a second swap.
This is not an external Nutshell-mint or production incident reproduction.

### Historical baseline before remediation

**Everything below describes the earlier, unfixed protocol and its original
verification run. The traces are retained as history, not current failures.
Current release verification is tracked in `docs/security-release-remediation.md`.**

Command:

```sh
TLA2TOOLS_JAR=/tmp/tla2tools-1.8.0.jar bash scripts/check-state-machines.sh
```

Runner exited **0**: seven safety checks passed and both diagnostics produced
their expected counterexamples. No “all cases safe” conclusion follows.

| Model/config | Generated states | Distinct states | Search depth | Result |
|---|---:|---:|---:|---|
| UcpCheckout | 72 | 26 | 6 | All configured safety invariants held |
| CashuEscrowOutbox | 454 | 159 | 12 | All configured safety invariants held under documented conversion assumption |
| SellerOrder | 6 | 6 | 4 | All configured safety invariants held |
| CustomDomain | 5 | 4 | 3 | All configured safety invariants held |
| ScheduledBlog | 70 | 38 | 10 | All configured safety invariants held |
| ProMembership | 20 | 7 | 5 | All configured safety invariants held |
| MobilePushDelivery | 40 | 20 | 5 | All configured safety invariants held |
| UcpCheckoutRetryRace (same UcpCheckout module) | 24 | 12 | 4 | **Counterexample** to ClaimRemainsSettleable; search stops at violation |
| CashuEscrowExpiryRecovery (same CashuEscrowOutbox module) | 396 | 149 | 11 | **Counterexample** to PreparedBeforeMint without protective conversion guard; search stops at violation |

Tool identified itself as `TLC2 Version 2026.11.19.180144 (rev: bc1b506)`.
The locally named jar was fetched from the official TLA+ release source and
checked against the published SHA-1:
`5db1e2fb5d8b4da2b49e06a217e6cdae5257b515`.
Its SHA-256 is
`fdffef247f563ef6edbfd44958d2a82db79e7564e07cb673262d896353fa6713`.
The local filename is not a reliable version identifier; use the tool banner and
digest when reproducing. Runtime: GraalVM Java 19, single TLC worker, 768 MB JVM
heap cap in the runner. No jar, generated state directory or trace is committed.

### Diagnostic trace

```
1. checkout=incomplete, retry=none, orderMayExist=FALSE
2. pre-order failure: checkout=requires_escalation
3. retry claim: checkout=incomplete, retry=claimed
4. completion request: checkout=complete_in_progress, retry=claimed
```

Historically, at step 4 the normal retry settlement SQL still required
`incomplete`. This was not a proof of a duplicate charge. The corrected route
and store now fence the competing write; this former diagnostic passes.

### Escrow diagnostic trace

```
1. locked escrow, absent outbox, unspent mint inputs
2. enqueue release, awaiting witness
3. witness supplied
4. worker claims generation 1
5. attempt passes expiry validation
6. prepared outputs persisted
7. mint inputs become spent; local finalization has not happened
8. lock window expires
9. failed attempt releases claim
10. worker claims generation 2
11. expiry conversion clears prepared outputs and chooses refund
```

The historical model kept external mint inputs spent at step 11: a DB
conversion could not unspend them. Clearing prepared outputs lost the modeled
NUT-09 recovery material. The old primary config hid this with
`ProtectSpentConversion = TRUE`; that assumption has now been removed. A
controlled mint and disposable real PostgreSQL reproduce the old SQL data
loss, roll it back, and exercise the corrected recovery path. There is no
evidence of a production loss.

## Implementation checks

- Initial focused run: 2 suites / 28 tests passed, exit 0.
- Expanded regression run: **22 suites / 240 tests passed, exit 0**, covering
  UCP utilities, retry/key isolation handlers, domain lifecycle, escrow worker,
  lifetime memberships, scheduled-post processing and failure records.
- An earlier expanded run passed 225 assertions but exited 1 after two schema
  tests leaked import-time database initialization past Jest teardown. Those
  schema-only tests now mock their unused DB boundary; the final expanded run
  exited cleanly without initializing persistence from those imports.
- Root TypeScript check (`tsc --noEmit --incremental false`, 3072 MB heap) passed,
  exit 0. The final **full `pnpm run typecheck`** also passed: web plus all five
  workspace targets (mobile, domain, nostr, API client, CLI), exit 0.
- `git diff --check` passed.
- The development workflow was restarted once. Its new production build
  compiled and generated routes, then Next.js stopped with `SecurityFatalError`
  reporting a known vulnerability in the installed framework. No automatic
  upgrade or bypass was performed. The workflow's last-good build remains
  available; a homepage screenshot confirms that fallback renders, **not** that
  the newly compiled server was promoted. The security-review task needs to
  assess the advisory and dependency upgrade.
- The screenshot browser logged event-cache HTTP 400 errors; no UI was changed
  in this work, and that fallback page is not validation of signed-in flows.

## Coverage interpretation

These checks exhaust the reachable states **of the finite abstractions**, not
of the entire application. See the inventory for the many documented but
unmodeled workflows, omitted stale-worker memory, external-service assumptions,
explicit retry/version bounds and lack of liveness/refinement proofs.
