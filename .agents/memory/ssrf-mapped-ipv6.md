---
name: SSRF guard must handle IPv4-mapped IPv6
description: Why any private-IP SSRF check has to decode ::ffff: mapped/compatible IPv6 addresses, and where the shared guard lives.
---

# SSRF private-IP guards must decode IPv4-mapped/compatible IPv6

Any server-side outbound fetch of a caller-supplied URL must go through the
shared guard in `utils/url-safety.ts` (`safeFetch` / `isSafePublicHostname`),
never a hand-rolled private-IP check.

**The non-obvious bypass:** a private-IP allowlist that only checks textual
IPv6 forms (`::1`, `fe80:`, `fc/fd`, `::`) is defeated by an IPv4-mapped or
IPv4-compatible address. An attacker sets a DNS **AAAA** record to
`::ffff:7f00:1` (hex) or `::ffff:127.0.0.1` (dotted) — the host passes the IPv6
rules, and on a dual-stack machine the OS connects to IPv4 loopback/internal
ranges. `isPrivateIPv6` therefore extracts the embedded IPv4 (both dotted and
hex tails, after stripping any `%zone`) and runs it through `isPrivateIPv4`.

**Why:** found during the "import stall design from URL" review — the original
`isPrivateIPv6` missed `::ffff:` entirely. The exploit is the DNS-record path
(URL literals get bracketed so `net.isIP` rejects them); the real caller is the
`lookup()` loop in `isSafePublicHostname`, which sees `family:6` mapped records.

**How to apply:** when adding ANY new feature that fetches a user-supplied URL
server-side (link preview, importer, webhook validator, avatar proxy…), reuse
`safeFetch`/`isSafePublicHostname` instead of re-implementing IP checks. If you
ever do touch the IP rules, keep the mapped-IPv6 decode and the IPv4 ranges
(incl. 100.64/10 CGNAT and 198.18/15 benchmark) in sync.

**Known residual:** DNS-rebinding TOCTOU — validation `lookup()` and the actual
`fetch()` resolve separately, so a TTL-0 server can answer public-then-private.
Shared with `pages/api/og-preview.ts`; a full fix needs IP pinning (undici Agent
custom lookup). Documented, deferred.
