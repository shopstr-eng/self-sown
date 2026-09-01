---
name: DNS-pinned Undici lookup
description: Node and Undici callback behavior required for DNS-rebinding-safe outbound fetches.
---

Custom DNS lookup callbacks used by an Undici dispatcher must support both
single-address and `all: true` requests. When `all` is requested, return the
full vetted address array rather than the single-address callback shape.

**Why:** Node 22 can request all addresses through the dispatcher. Returning a
single address in that branch produces an `ERR_INVALID_IP_ADDRESS` with an
undefined address, so every protected outbound request fails even though mocked
fetch tests pass. The Undici implementation used by production must also be an
explicit runtime dependency, not available only through development tooling.

**How to apply:** Any change to DNS pinning or the Node/Undici version needs a
real public-network smoke test through the built standalone application. Keep
redirects manual and revalidate every followed hop against the vetted public
address policy.