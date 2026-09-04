---
name: Order DM seller-relay delivery
description: Why order gift-wrap DMs must target the SELLER's relays (server + client) and how delivery is wired
---

# Order DM delivery must reach the SELLER's relays

The orders dashboard reads order messages by subscribing client-side (PWA) to the
**seller's own** relays. The order gift-wrap (kind 1059) is built and published
client-side from the cart/product invoice cards.

**The trap:** the client publish targets the BUYER's relays + blastr
(`withBlastr([...writeRelays, ...relays])`). On a seller's custom domain the buyer
is usually a guest with empty localStorage, so it publishes only to default relays

- blastr — relays the seller's dashboard does not read. Result: the confirmation
  email arrives (server-side, relative URL) but the order never shows on the
  dashboard.

**Why:** delivery target was tied to the _buyer's_ relay set, not the _recipient
seller's_. Email worked because it was already server-side and origin-independent.

**How delivery is now wired (two independent paths, both fire-and-forget so they
never add latency to or change the success of checkout):**

1. Primary — server republishes the already-signed gift-wrap to the seller's
   relays. A signed kind-1059 event is self-authenticating, so the server needs
   NO private key to publish it; it just needs the seller's relay list (cached
   NIP-65 kind 10002) ∪ defaults ∪ blastr. Recipient = the gift-wrap's `p` tag.
2. Fallback — the browser also publishes to the seller's relays directly, after
   discovering them via NIP-65 indexer relays (purplepag.es / relay.nostr.band,
   always included in the lookup so it's server-independent). This keeps orders
   landing on relays even if our server is down.

**How to apply:** enable seller-relay delivery only for seller-bound order
messages (`!!orderId && !isReceipt && !isDonation`) — not buyer receipts (their
ephemeral recipient key has no relay list, so it just wastes a discovery timeout).

**Server-CREATED DMs have the same trap.** `sendServerSideNostrDM` publishes
only to the default relay set; `sendServerSideNostrDMToRecipientRelays` is the
variant that resolves the recipient's NIP-65 read relays ∪ defaults ∪ blastr.
**Why:** a server-signed DM (escrow payout notification, Pro receipt) to a
recipient who reads non-default relays silently never arrives.
**How to apply:** any new server-originated payee/recipient-facing DM should
use the recipient-relay variant; keep the plain one only where default-relay
delivery is intentional.

**Cache-miss ≠ delivered (verified in staging 2026-09).** The recipient-relay
variant resolved NIP-65 lists from the Postgres `config_events` cache only; a
miss fell back to defaults+blastr — and blastr federation MASKED the gap in
staging (wraps reached the payee's non-default relays within ~16s anyway).
Federation is luck, not a guarantee. There is now a live NIP-65 indexer
fallback (purplepag.es / relay.nostr.band, `NIP65_INDEXER_RELAYS` override)
with verified kind/author/signature, newest-wins, best-effort cache mirror,
and a `[nip65-fallback]` log breadcrumb. The staging e2e
(`scripts/e2e-escrow-payout-dm-relays.mjs`) proves the fallback with an
in-process fake relay because both public indexers are unreachable from the
sandbox egress.

**Server relay I/O uses `utils/nostr/contained-relay.ts`, never SimplePool.**
Why: pool.publish leaks dangling socket errors as uncaughtException when a
default relay is unreachable, and querySync waits for EVERY relay's EOSE so
one dead indexer discards a live one's results. The contained client gives
each relay one deadline over DNS+connect+response, a pinned public-only DNS
lookup at the dial (`createPublicOnlyLookup` in utils/url-safety — validation
then reconnect leaves a rebind window; nostr-tools' global
useWebSocketImplementation can't pin per-connection), pre-parse inbound
frame/byte budgets, and a client-side event cap (Nostr `limit` is only a
request). Attacker-controlled NIP-65 targets never get `allowPrivate`.

**Test gotcha:** `finalizeEvent` stamps `Symbol(verified)`, which survives
object spread and short-circuits `verifyEvent` — tamper-test fixtures must be
JSON round-tripped, or signature-verification tests pass on forged events.

**Read-path symmetry (the other half of resilience):** delivering an order to the
seller's relays + server cache only helps if the dashboard READ path actually
merges the server copy. Profiles and products already merge DB ∪ relay for display.
The gift-wrapped message/DM read path historically fetched the server-cached wraps
but used them ONLY for read/unread status — the displayed chat list was built purely
from relay events, so a DB-only message (relay dropped it / never had it) never
showed. Fix: build a union of relay wraps ∪ cache-only wraps keyed by event.id and
decrypt both through the same path. The DB stores the same encrypted kind-1059 wraps
(id, pubkey, content, tags, sig), so cache events decrypt identically.
**How to apply:** when touching the message fetch path, ensure cache events are
merged into the DISPLAY, not just consulted for metadata; and any per-event failure
(missing `p` tag, bad decrypt/JSON) must `continue`, never `return`, or one bad
event aborts the whole fetch (the executor never resolves) — blast radius grew once
cache-only events also flow through that loop.

**Endpoint abuse note:** an endpoint that republishes arbitrary signed events to
relays is a relay-amplification/cache-write primitive. Gift-wraps use a fresh
random outer pubkey each send, so per-pubkey rate limiting is useless — guard with
a tight per-IP limit, a per-event-id dedupe window, and a hard per-event size cap.
You CANNOT require order-specific tags on the outer event: order info is encrypted
inside the gift-wrap; only the `p` tag is visible.
