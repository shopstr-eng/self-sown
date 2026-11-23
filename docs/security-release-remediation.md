# Web and mobile release-remediation status

Updated 23 November 2026. This records **source work on main**, not a
production deployment or a signed App Store binary. Do not treat an exported
iOS JavaScript bundle as a TestFlight upload.

## Addressed in source

- **Checkout retry race:** the durable row distinguishes an owned retry from
  an ordinary incomplete checkout. All normal completion/status writes require
  the expected status and reject a claimed retry; retry settlement or rescue
  clears ownership. Real PostgreSQL tests race eight retry claims and eight
  completion writes across success, pre-order failure, ambiguous outcome, and
  post-order persistence failure, including a subscription with no order ID.
- **Escrow expiry after mint spend:** an expired release with prepared outputs
  cannot be converted into a refund by either conversion SQL or the worker.
  Spent-input recovery uses NUT-09 and persisted output material; a fresh
  seller-directed swap remains prohibited after expiry. A real PostgreSQL
  transaction replays the retired clearing update and rolls it back; a
  controlled mint then demonstrates post-swap finalize failure followed by
  expired recovery, one swap total. Unspent/unknown/partially resolved mint
  states fail closed rather than assume the external swap did not occur.
- **OAuth account key:** the callback no longer includes an nsec or handoff
  token in a URL. It issues an opaque, Secure, HttpOnly, same-origin, 120-second
  cookie. Redemption atomically consumes a server-encrypted record; replay
  fails. The browser re-encrypts with a user-chosen local passphrase, preserves
  old ciphertext until migration succeeds, and OAuth signers never persist the
  unlock passphrase in sessionStorage, even with the memory-only remember
  control.
- **Development dependencies:** the installed Expo CLI rejects oversized
  plugin chunks, unbounded result arrays and cumulative output before Zod
  validation. The installed glob 10 and minimatch 9/10 packages carry
  compatible, checked-in patches for the reported abort and pattern-expansion
  paths. Expo's legacy ngrok UUID is overridden to a supported nonvulnerable
  major; glob 13.0.7 already contains the missing early returns. Installed
  package behavior is directly covered by regression tests. These patches
  keep the older version strings in the lockfile; version-only scanners will
  still report them.
- **Operational logs:** direct customer email addresses were removed from the
  Stripe subscription/webhook failure messages and rejected custom-sender
  errors; the payment identifiers remain for troubleshooting.

## Executed verification

- TLC ran eight bounded state-machine models and the two original diagnostic
  configurations; all **10 passed**, without the old escrow protection
  assumption. Exact tool pin, counts, scope and historic counterexamples are
  in `formal/state-machines/RESULTS.md`.
- Focused isolated unit/regression runs passed: an eight-suite/142-test run,
  a broader 21-suite/228-test checkout/OAuth run, and further mobile/UI
  regression runs. The dependency regression suite passed 13 tests; an
  additional signer/UI/dependency run passed 59 tests. Five new real-Postgres
  release-protocol tests passed, and the existing six-test real-Postgres
  escrow-concurrency suite passed. These are overlapping runs, **not an
  additive total**.
- The iOS Expo production bundle exported offline (one 6.5 MB Hermes bundle).
  Web and mobile typechecks and four workspace package typechecks passed.
  Tests, typechecks and export used a no-network namespace with no ambient
  credentials, read-only source/toolchain mounts, bounded scratch and CPU.
  The database was disposable and reachable only via a scratch Unix socket.
- Fresh native scans completed: dependency audit **0 critical, 1 high, 7
  moderate**, static scan **12 medium**, dataflow scan **11 critical, 4 medium,
  38 low**. Counts include patched version-based advisories, test fixtures and
  deliberate ciphertext storage; they are not all exploitable findings. Do
  not suppress categories without reviewing the affected source and payload.

## Open release gates and limitations

1. **DeepSec has not been run.** Native dependency, static and dataflow scans
   are not a DeepSec AI security review. A DeepSec installation/model
   authorization and an isolated read-only review of this tree are still
   needed to satisfy the requested DeepSec gate. Do not send this repository
   to an untrusted unsandboxed agent or imply the review is complete.
2. The dependency scanner still reports Zod 3 (high): the demonstrated
   *Expo dev-tools* oversized-plugin path is bounded before Zod, but this
   does not prove that every Zod callsite in the application has a bounded
   collection. Glob 10/13, minimatch 9/10 and previously patched elliptic
   remain reported by version. The moderate Hono static-prefix advisory
   requires checking any nonpublic file serving when its parent dependency
   changes. Reassess with the upstream fixes when compatible.
3. The dataflow scanner's encrypted local-key findings are acceptable **only
   for ciphertext-only payloads**. Its lower-severity orderSummary/storage
   and PII logging findings need exact payload-by-payload review. A scanned
   email send to an external service is not itself a stderr leak. The static
   OAuth redirect warnings require verifying the origin anchor, cookie
   attributes and provider proof on any future edits.
4. TLC establishes finite bounded safety properties for the modeled
   workflows, not a proof of all implicit states in every UI module, all
   network failures, or real mint behavior. The combined escrow test uses
   a controlled mint adapter, not a live external mint.
5. No newly changed signed-in web screen, deployed web backend, EAS native
   build, entitlements in its embedded provisioning profile, TestFlight binary,
   or production release was verified or published in this remediation.
   Rebuild and review those separately after the security gate clears.
