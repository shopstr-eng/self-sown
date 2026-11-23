# Application state machines

## Scope and how to read this inventory

This is a repository-wide **identified-workflow inventory**, not a claim that
every possible combination of React hooks or external SDK states was discovered.
The discovery pass covered about 1,600 TS/JS/native source files in `apps`,
`packages`, `pages`, `utils`, and `mcp`: status/state/phase declarations and
assignments, retries, claims, timers, pending-operation stores, and database
constraints were searched. Tests, schemas, and handlers were used to resolve
important transition guards. A keyword match is a candidate, not a distinct
machine; copies of a shared workflow in web/mobile are grouped below.

**Explicit** means named states and a central transition/resolution point already
exist. **Distributed** means transitions are spread across handlers or storage
operations. **Composite** means the actual state depends on multiple fields,
timestamps, claims, or presence/absence of a row. A typed status union by itself
does not enforce legal transitions or concurrency safety.

The owner column names the authoritative code/storage boundary, not a person.
`TLA` names a bounded abstraction described below; `—` means not modeled.
No external service, production data, or database schema was changed.

## Coverage ledger: durable and money workflows

| Workflow / owner | Representation | Events, guards, effects, failures and invariants | TLA |
|---|---|---|---|
| UCP checkout — `utils/ucp/checkout-status.ts`, `checkout-store.ts`, `pages/api/ucp/checkout/sessions/` | Distributed: incomplete, ready_for_complete, complete_in_progress, completed, requires_escalation, canceled; plus order ID, error/code and stored payment | Creation stores payment instructions; Cashu may complete immediately. GET/complete reconciles order payment; pending completion waits; failed payment escalates; refund cancels. Retry is only a pre-order escalation, key/host scoped and atomically claimed as incomplete. Provably pre-order failure reopens escalation; uncertain outcome must not invite a second order. Terminal states are intended to remain terminal, but generic SQL updates are not compare-and-set. | UcpCheckout |
| Seller order fulfillment — `utils/db/db-service.ts` (`transitionSellerOrderStatus`), `utils/orders/persist-order-status.ts`, `packages/domain/src/order.ts` | Explicit: pending → confirmed → shipped → completed; canceled off-ramp | Seller alone advances fulfillment; buyer alone cancels pending/confirmed. Expected status/version and transition ID protect conflicts/idempotency; unauthorized actors fail. Persisted state precedes notification, with replayable notification paths. Terminal orders must not resurrect. | SellerOrder (sequential actor-authorized path only) |
| MCP order — `mcp/tools/purchase-tools.ts`, `utils/ucp/order-service.ts` | Composite: independent payment and fulfillment axes | Shared order engine initializes order, stock/payment and notifications. Payment provider verification changes payment status; seller fulfillment is separate. Never infer paid from shipped or vice versa. A failure after an external effect is ambiguous, not proof no order exists. | UCP projection only |
| Cashu escrow — `utils/db/cashu-escrow-service.ts`, `utils/cashu/escrow-payout-worker.ts`, `escrow-payout.ts` | Composite: registration locked/released/refunded × outbox pending/processing/done × release/refund × witness/payload readiness | One outbox per escrow arbitrates resolution. Claim token fences persistence. Persist prepared outputs before mint spend; spent input retry restores outputs rather than spending again. Failed attempts release claims; stale claims may be reclaimed. Expired release converts to refund awaiting buyer payload. Notifications happen after durable finalization. | CashuEscrowOutbox (partial; assumptions below) |
| Cashu mint quotes — `utils/cashu/pending-mint-operations.ts`, `mint-retry-service.ts` | Explicit statuses plus durable pending quote records | Quote starts unpaid, becomes paid/unclaimed, then minted/removed; terminal failures retained. Polling/reload retries use mint authority and operation identity. Issuance must be reconciled before adding proofs twice. | — |
| Cashu melts — `utils/cashu/melt-retry-service.ts` | Explicit outcomes paid/unpaid/pending/unknown | Proof reservation → mint request → observed settlement or uncertain result. Recheck quote/proof state after timeout; unknown is not unpaid. Paid result must remain paid despite later local acknowledgement failure. | — |
| Cashu swaps — `utils/cashu/swap-retry-service.ts` | Explicit outcomes swapped/unswapped/unknown | Retry reconciles spent proofs and recorded outputs. Uncertain transport result cannot authorize a new spend or restore input balance blindly. | — |
| Outgoing Cashu tokens — `utils/cashu/outgoing-send-tokens.ts` | Explicit: unclaimed/claimed/reclaimed | Recipient spending marks claimed; sender reclaim swaps unspent proofs and marks reclaimed. Mint authority resolves who spent first. Local record alone is not evidence proofs remain spendable. | — |
| x402 payments — `utils/x402/` | Distributed quote/receipt/proof and cleanup state | Payment validates quote and settles proofs before receipt cleanup. Paid-but-unacknowledged and expired quotes are distinct; deletion follows durable settlement postconditions. External mint/payment replay is not modeled here. | — |
| Stripe pending payments — `utils/stripe/pending-payments.ts`, `retry-service.ts` | Composite pending local record, provider state and retry metadata | Prepare payment, confirm with provider, fulfill/store success, remove pending record; failures retain enough identity to retry reconciliation without charging twice. | — |
| Stripe webhook deduplication — `utils/stripe/processed-events.ts`, webhook handlers | Composite absent/claimed/processed event and claim timing | Duplicate/replayed provider events share a durable claim; effects must be idempotent and claim failure must not be mistaken for processed success. Provider ordering and signatures remain external contracts. | — |
| Payout/application-fee claims — `utils/stripe/payout-claims.ts`, `utils/geo/fee-claims.ts` | Composite claim/result records | Atomic claim → external transfer/fee effect → durable result. Retry checks provider identity; DB claim alone cannot prove exactly-once external execution. | — |
| Subscriptions — `utils/pro/`, Stripe subscription routes and webhooks | Provider-owned status mirror plus cancellation/period fields | Checkout/webhook creates or renews; past-due, cancellation, refund and out-of-order events reconcile access. A browser success URL alone is not evidence of payment. | Membership projection only |
| Pro membership — `utils/pro/membership-status.ts`, `constants.ts` | Explicit derived state: free/trialing/active/grace/readonly/hidden, with lifetime override | Trial/paid grants establish timestamps; time crosses entitlement/grace/readonly boundaries; renewal can reactivate lapsed states. Lifetime always active. No timeline means free; elapsed timeline means hidden. | ProMembership (ordered timeline abstraction) |
| Manual membership invoices — `utils/pro/`, invoice routes | Composite invoice payment record, claim and membership extension | Verified payment grants time once, concurrent terms stack atomically; unpaid/expired/in-flight are not grants. | — |
| Affiliate referral settlement — `utils/db/affiliates.ts`, `db/schema.sql` | Distributed pending/payable/paid/cancelled/refunded, payout ID and hold age | Completed purchase accrues referral; cadence hold promotes pending to payable; batch payout records paid. Refund before payout cancels the liability; refund after payout marks refunded for reconciliation. Dedup binds canonical payment/order identity, not a caller's alternate order ID. | — |
| Affiliate invitation and payout eligibility — `utils/db/affiliates.ts` | Composite invite claimed time, account identity, Stripe onboarding flags, payouts_enabled and consecutive failure count | Claim invitation binds affiliate identity; configure payout destination; automated failures increment count and disable payouts at the cap; seller correction/re-enable resumes. Disabled/onboarding-incomplete is not payable merely because a referral is payable. | — |
| Shipping label purchase — `utils/shipping/outbound-label-purchase.ts`, `claim-reconcile.ts` | Composite claim, provider transaction, pending/ambiguous/result data | Claim → buy provider label → persist. Timeout may mean purchased; reconcile metadata token and wait through provider in-flight states before releasing. Replay must not buy twice; unknown is not failed. | — |
| Checkout shipping quote — checkout consumers and `utils/shipping/` | Composite input key, debounce, pending request and selected rate | Address/parcel/cart edits invalidate a rate; only matching latest inputs may consume quote. Out-of-order HTTP responses must not charge a stale rate. | — |

## Coverage ledger: background work, account and UI workflows

| Workflow / owner | Representation | Events, guards, effects, failures and invariants | TLA |
|---|---|---|---|
| Custom domain — `utils/custom-domain-lifecycle.ts`, `utils/db/custom-domains.ts` | Composite verified flag + pending_dns/dns_verified/attached/active/failed | DNS ownership success marks verified; verified DNS-ready/attached host with successful TLS probe becomes active. Probe outage is no event, not a demotion. Administration remains a separate override; membership gates visibility independently. | CustomDomain (automatic happy path; overrides excluded) |
| Scheduled blog — `utils/db/db-service.ts`, `pages/api/storefront/blog/process-scheduled.ts` | Composite draft/scheduled + due time + processing_at; published/deleted represented by row removal | Edit replaces signed event, clears claim/error/attempt count. Due cron claims with SKIP LOCKED; stale claim can be reclaimed. Failure records error/retries; success deletes only matching event ID so a newer edit survives. Relay broadcast and email are separate external effects, not an atomic DB transaction. | ScheduledBlog (single-worker/version abstraction only) |
| Blog email broadcast — blog routes and email broadcast ledgers | Composite segment-version claims plus immutable recipient ledger | Eligible audience selected before claim; sends recorded per recipient. Repeat publish/source changes must not resend the same claimed version unexpectedly. Provider acceptance does not prove inbox delivery. | — |
| Email flow definition — `utils/email/flow-scheduler.ts`, email-flow routes | Explicit draft/active/paused | Seller activation enables enrollment/scheduling; pause stops future processing; edits must preserve enrollment/execution semantics. | — |
| Email enrollment — flow scheduler and DB accessors | Explicit active/completed/cancelled plus execution rows | Trigger enrolls, steps scheduled, completion/cancel ends enrollment. Enrollment and scheduling are separate operations; scheduling failure cancels stranded enrollment. | — |
| Email step execution — flow scheduler and processor | Distributed pending/sent/failed/skipped plus due time | Due active step claims/executes, provider success marks sent; suppression, conditions and cancellation skip; failures record state. Tracking clicks/opens are observations, not send success. | — |
| Email bounce/suppression — SendGrid event webhook and email consumers | Composite subscription/suppression and provider event | Verified bounce/unsubscribe updates eligibility; broadcasts and flow sends must consult it. Duplicate webhook events must be harmless; webhook validation precedes mutations. | — |
| Mobile push — `utils/db/mobile-notification-service.ts`, `utils/notifications/worker.ts` | Composite queued/sending/accepted/provider_accepted/retry_wait/invalid_device/failed/expired/superseded + lease/device generation | Materialize activity per binding; claim due enabled binding; provider ticket accepted then receipt checked. Retryable errors back off, invalid device disables, old binding supersedes. Stale lease reclaimed; old worker must not overwrite new owner. | MobilePushDelivery (single-current-owner abstraction only) |
| Push permission and installation binding — `packages/domain/src/notifications.ts`, mobile notification registration | Explicit not_requested/enabled/disabled/os_denied/registration_pending/registration_failed plus server binding generation | User permission precedes OS token registration; challenge/confirmation binds installation; logout, account change and token refresh invalidate/rebind generation. OS denial, server registration failure and user-disabled are distinct recovery paths. Delivery lifecycle above is independent. | — |
| Mobile order notification outbox — `apps/mobile/lib/order-notification-outbox.ts` | Composite pending local transition notification and persisted status | Persist order status, then relay notification; interrupted send remains retryable. Notification failure must not roll back fulfillment or skip an intermediate canonical transition. | — |
| Mobile POS sale — `apps/mobile/lib/pos-sale.ts`, `pos-card-sale.ts`, POS screens | Distributed cart/ready/processing/result and order creation | Cash/card sale creates self-addressed order rumors per line, advances canonical fulfillment and queues notification. Approved/not-approved/unknown-outcome differ; unknown card outcome must not invite a blind charge retry. Cancellation may race SDK completion. | — |
| Tap to Pay reader — `apps/mobile/lib/pos-tap-to-pay.ts`, settings/checkout screens | Distributed unavailable/disabled/discovering/connecting/connected and SDK reader identity | Explicit user enablement starts discovery/connection; permissions, device support, account location and entitlement gate it. Reuse connected reader; disconnect/failure allows recovery. SDK/device transitions are external and need physical-device tests. | — |
| Storefront lookup — `utils/storefront/use-storefront-lookup.ts`, `storefront-lookup-client.ts` | Composite route identity, loading/data/error/negative cache and request generation | Navigation starts lookup; response only applies to matching route. Genuine 404 may cache negative, transient errors retry. Old request must not display another shop. | — |
| Authentication/hydration — `apps/mobile/stores/session-store.ts`, auth providers | Composite loading/anonymous/signed-in, credential source, encryption and per-account persistence | Hydrate/decrypt/sign in/switch/logout; restore failure is not authenticated. User-scoped caches cleared/rebound on switch; server token revocation gates requests independently of UI. | — |
| Passphrase signing prompt — signer provider | Composite unresolved challenge resolver and in-flight sign | One challenge at a time; concurrent signatures share/serialize prompt; success/cancel settles waiters. A replaced resolver must not strand an earlier sign. | — |
| OAuth/browser checkout/recovery — mobile Stripe/Square connect and account recovery helpers | Explicit callback result plus browser-sheet/deep-link state | Launch browser, validate state/return parameters, resume or cancel; browser closed/resolved is not necessarily success. Server verification is authority. | — |
| Listing lifecycle/editors — `packages/domain/src/listing.ts`, mobile/web listing writers | Explicit active/inactive plus draft/publishing/error local state | Publish signed event, archive/reactivate by new event. Address/timestamp dedup chooses latest version; failed publish must not silently overwrite local authoritative fallback. | — |
| Storefront/profile save/import — seller editors, `utils/storefront/`, `/convert` pipeline | Composite dirty/saving/saved/error, load races, signed relay event and cache | Hydration may arrive DB/relay/timeout; edits normalize/validate and publish before local fallback. Retry must not erase unowned fields or apply an old load over new input. | — |
| Client async forms/uploads/cart dialogs | Repeated local idle/loading/success/error, often several booleans | Submit disables duplicate local action; rejection restores interaction and exposes errors; navigation/unmount invalidates late results. Grouped family, **not an exhaustive component-by-component audit**. Product-specific combinations remain unmodeled. | — |

### Status-like values that are not independent temporal machines

- Geographic `state` columns are addresses/jurisdictions, not lifecycle state.
- `utils/regulations/schema.ts` has clarify/answered/unknown **result variants**:
  each question runs the deterministic engine afresh. Without a retained
  conversation/session transition, these are not a three-step workflow. Corpus
  review/attorney approval is a separate human process; this inventory does not
  certify it.
- `utils/custom-domain-www-health.ts` derives a current DNS/TLS observation;
  it must not be treated as a persisted domain transition. Only the lifecycle
  advancer writes the automatic progression.
- Loading/saving/error values replicated across editors are grouped as one UI
  family, not counted once per matching identifier. External SDK enums and
  provider receipt objects are modeled only through the app workflows consuming
  them, not as implementations of the provider itself.

## What became explicit in implementation

1. `CHECKOUT_STATUS_TRANSITIONS` and `canTransitionCheckoutStatus` name and test
   the **sequential intended graph**. Retry's special escalation → incomplete
   edge remains in its key-scoped atomic store claim, not the generic graph.
   This does **not** add a new DB fence or silently change existing checkout
   behavior. Generic update concurrency remains a finding below.
2. `transitionCustomDomainState` names DNS-verified and TLS-ready events over
   `{verified, tlsStatus}`. The lifecycle driver applies returned state only
   after its existing DB write succeeds. Failed probes produce no event.
   The administrative override is deliberately not forced into automatic rules.
3. Composite workflows above now have named logical states and documented
   transitions without a risky schema migration. Their persisted representations
   remain compatible. Replacing provider-owned states or every UI boolean with a
   new framework would change scope/behavior rather than improve this inventory.

## Findings and limits

### UCP completion can interrupt a retry's settlement fence

The route `.../[id]/complete.ts` acknowledges a row without `mcp_order_id` by
writing `complete_in_progress`, including an incomplete row claimed by `/retry`.
The retry settlement then requires `status = 'incomplete'`.

The diagnostic config `UcpCheckoutRetryRace.cfg` reproduces:

```
incomplete
→ pre-order failure: requires_escalation
→ retry claim: incomplete, retry running, no attached order
→ concurrent complete: complete_in_progress, retry still running
```

This violates **ClaimRemainsSettleable**. The retry route has status-preserving
rescue behavior, so this trace is **not proof of a duplicate charge**. It shows
that a legal completion call can force retry into its fallback/unsettled path;
a provably pre-order retry failure can also fail to reopen cleanly. Fixing it
needs a distinct durable retry/attempt marker or an explicit completion guard,
with concurrency tests. No product behavior was changed to hide the trace.

The generic status update is also `WHERE id = ...`, not compare-and-set. Two
requests can read the same old status and write in the opposite order, even
though sequential routes short-circuit terminal states. The intended transition
map is therefore **not** proof terminal states stay stable under concurrent
requests. The current model does not simulate these stale read snapshots.

### Escrow expiry can discard recovery material after an unrecorded mint swap

The escrow model assumes conversion to refund only while the abstract mint
inputs remain unspent (`ProtectSpentConversion = TRUE` in its safety config).
The implementation's worker checks expiry before payout; conversion storage
does not consult the external mint and clears `prepared_outputs`.

`CashuEscrowExpiryRecovery.cfg` sets that protective assumption to FALSE,
matching the conversion SQL, and checks the recovery invariant:

```
claim release → validate → persist prepared outputs → mint spends inputs
→ expiry → failed/stale attempt released → next claim
→ convert to refund, clearing prepared outputs while inputs remain spent
```

TLC finds that counterexample. It is a **source-grounded recovery-loss candidate**,
not proof of a production incident or exploit: the model abstracts the mint,
process crash and SQL into actions, and the scenario still needs an actual
staging mint/DB reproduction. Fixing it requires preserving/reconciling the
prior swap's recovery evidence before choosing refund. Do not read the primary
config's passing checks as proof this implementation race is handled.

### Deliberately unmodeled

Rows marked `—` are documented, not formally verified. Even named models omit
money arithmetic, proof cryptography, signatures, permissions, server crashes
between every SQL statement, arbitrarily many workers, provider behavior,
notifications and network contents except where explicitly represented. The
scheduled-blog and push models do not retain independent stale worker snapshots;
their passing checks do not prove stale-worker fencing or exactly-once delivery.
There is no repository-wide completeness theorem and no refinement proof linking
TypeScript/SQL execution to TLA+. This deliverable must not be described as “all
cases proved safe.”

## Formal models, invariants and bounds

All specs/configs are under `formal/state-machines/`.

| Model | Checks | Bound / abstraction |
|---|---|---|
| UcpCheckout | type safety, claimed retry has no order yet, ambiguous result conservatively blocks new order, completed means paid, canceled means refunded | one session/order-existence bit; finite payment outcomes; sequential actions plus the completion/retry interaction; no subscription-provider or stale DB snapshots |
| CashuEscrowOutbox | types, current claim ownership, no unwitnessed release claim, prepare before mint spend, released funds were swapped in open window, finalized outputs recorded | one escrow, two worker identities, at most two claim generations; mint unspent/spent; conversion assumption above; only current owner represented |
| SellerOrder | valid canonical states, seller-only advancement, buyer cancellation only before shipping | one order; authorized actor actions, no DB/version or relay concurrency; terminal states have no outgoing action |
| CustomDomain | types, active implies ownership verified | one newly registered domain, automatic forward transitions only; probe failures stutter; failed/admin override states are not reachable from modeled initialization |
| ScheduledBlog | types, claim only while publishing and bound to current version | one post, versions 0..2, up to two failures; row deletion represented by logical published/deleted states; single current worker, no retained old broadcast |
| ProMembership | types, lifetime remains active | one membership with ordered timeline stages; time may stutter; renewals/lifetime grant; malformed/missing intermediate timestamps and revoking lifetime excluded |
| MobilePushDelivery | types, sending has current owner, invalid device disables token, terminal delivery has no lease | one delivery/device, two worker identities, two claims/attempts; lease expiry abstracted into nondeterministic reclaim, no independent stale worker memory or timing/backoff guarantees |

`CHECK_DEADLOCK FALSE` is intentional: terminal states and finite retry bounds
can have no outgoing action, and the specs permit stuttering. These are **safety
checks**, not liveness proofs. No fairness is assumed for human payment, DNS,
relay delivery, retry scheduling or external providers, so eventual completion
cannot honestly be asserted.

## Reproduce

Use Java 11+ and an official verified `tla2tools.jar` from
<https://github.com/tlaplus/tlaplus/releases>. Keep the jar and TLC state/log files
outside the repository. The runner copies specs to a temporary directory and
cleans up afterward:

```sh
TLA2TOOLS_JAR=/absolute/path/to/tla2tools.jar bash scripts/check-state-machines.sh
```

The runner requires all seven safety configs to pass, then requires both the
completion/retry and escrow expiry/recovery diagnostics to produce their named
counterexamples. A successful runner exit means **all those expectations** held,
not that the diagnostic properties passed. If an interaction is fixed, update
the model and diagnostic expectation together; do not just delete the invariant.

Focused implementation checks:

```sh
pnpm exec jest --runInBand --no-coverage \
  __tests__/utils/ucp/checkout-status.test.ts \
  __tests__/utils/custom-domain-lifecycle.test.ts
NODE_OPTIONS='--max-old-space-size=3072' pnpm exec tsc --noEmit --incremental false
```

See `formal/state-machines/RESULTS.md` for the actual run outcomes.
