---
name: Mobile speaks NIP-47 directly, web uses @getalby/sdk
description: @getalby/sdk is a web-only dependency; any mobile NWC feature must re-implement the NIP-47 exchange over nostr-tools instead of importing the SDK.
---

# Mobile speaks NIP-47 directly, web uses @getalby/sdk

The web app's wallet features (settings NWC section, ZapsnagButton, invoice
cards) use `NostrWebLNProvider` from `@getalby/sdk`, which is only in the root
package.json — not in apps/mobile. Mobile NWC features live in
`apps/mobile/lib/nwc.ts`, which re-implements the NIP-47 exchange (kind 13194
info event, kind 23194/23195 request/response, NIP-44 v2 preferred with NIP-04
fallback) over `nostr-tools` directly.

**Why:** keeping the web-oriented SDK out of the mobile bundle; nostr-tools is
already a proven mobile dependency (secure-outbox-storage.ts uses it).

**How to apply:** any new mobile NWC method (e.g. pay_invoice) belongs in the
mobile NWC lib, not via a new @getalby/sdk dependency. Two SDK-compatibility
rules are easy to miss: (1) every NIP-47 request event must carry both
`["encryption", ...]` and legacy `["v", ...]` tags — the Alby wallet service
defaults untagged requests to NIP-04 and silently fails to decrypt NIP-44
payloads; (2) the connection string is a spending credential and must live in
SecureStore (pubkey-scoped), never plaintext AsyncStorage — note SecureStore
keys forbid ":", use "." as the pubkey separator.
