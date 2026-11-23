# State-machine check results

Run date: 2026-11-23. Scope, source owners, model limitations and findings:
[`docs/state-machines.md`](../../docs/state-machines.md).

## TLC

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

At step 4 the normal retry settlement SQL still requires `incomplete`. This is
grounded in the actual `/complete` route and retry store, but is not a proof of a
duplicate charge; the route's rescue path is specifically intended to block
unsafe new orders. The diagnostic is kept separate from the safety configs so a
passing runner cannot conceal a failing property.

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

The model keeps external mint inputs spent at step 11: a DB conversion cannot
unspend them. Clearing prepared outputs loses the modeled NUT-09 recovery
material. This is a candidate reliability flaw requiring a real mint/DB
reproduction, not a demonstrated production loss. The primary escrow config
adds `ProtectSpentConversion = TRUE`; the diagnostic disables that assumption
to represent the existing conversion SQL.

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
