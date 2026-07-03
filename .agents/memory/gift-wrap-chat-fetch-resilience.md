---
name: Gift-wrap chat fetch resilience contract
description: Invariants for fetchGiftWrappedChatsAndMessages so Orders-dashboard messages never silently blank out.
---

# Gift-wrap chat fetch must degrade, never blank

`fetchGiftWrappedChatsAndMessages` (`utils/nostr/fetch-service.ts`) loads order
messages for the Orders dashboard by double-unwrapping kind-1059 gift wraps
(1059 → seal kind 13 → rumor kind 14). It is the hot path that was reported as
"slow and SOMETIMES fails to display entirely."

**Hard contract — do not break these or messages vanish:**

- **Never `reject`.** Both call sites (`pages/_app.tsx`) wipe the chat context to
  an empty `Map` when the promise rejects. So the outer `catch` must publish
  whatever partial `chatsMap` it has and `resolve`. Declare `chatsMap` BEFORE the
  `try` so the catch can still publish it.
- **Isolate each wrap.** One malformed / spam / rotated-key wrap must be caught
  per-wrap (in `decryptWrap`) and skipped, never thrown out of the batch. The old
  serial loop let a single bad decrypt blank EVERY message.
- **Relay fetch is non-fatal.** The same encrypted wraps are cached in Postgres,
  so wrap `nostr.fetch` in its own try/catch and keep showing the cached view on
  relay error.
- **Incremental publish.** Render server-cached wraps first (phase 1), then merge
  relay results (phase 2). Only publish phase 1 when the DECRYPTED map is
  non-empty (a cache of pure DMs all get filtered out — publishing empty would
  flash a "no orders" table before relays answer). Always publish once at the end
  (even empty) so the spinner clears. Pass a NEW `Map(chatsMap)` each publish so
  React sees a fresh reference.
- **Dedup across phases** via a `processedWrapIds` set, or a wrap present in both
  cache and relay renders twice.
- **Read status** comes from `chatMessagesFromCache` (`is_read`), not the relay.
- **Only persist new signed relay events** (`e.id && e.sig && e.pubkey && e.kind===1059`);
  cached rows are already in the DB.

**Why bounded concurrency (8):** for a NIP-46 (bunker) signer each `decrypt` is a
relay round-trip, so a serial loop over N orders is 2N sequential round-trips
(the slow symptom). A small worker pool parallelizes them; concurrent unlocks are
safe because `NostrNSecSigner._getPrivKey` is single-flight (see
`concurrent-signer-challenge.md`).

**Orders-dashboard coupling:** the `markAllMessagesAsRead` effect must depend on
`chatsContext.chatsMap` too (it's idempotent) so it re-runs when the phase-2
merge publishes a fresh map after the cached-first paint.
