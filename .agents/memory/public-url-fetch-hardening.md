---
name: Public server-side URL fetch hardening
description: Turning an authed URL-fetcher/extractor public re-exposes DoS vectors that auth was silently bounding — stream+cap bodies with a read deadline.
---

Before exposing any previously-authed server-side "fetch an arbitrary user-supplied URL" pipeline as a PUBLIC/ungated endpoint, re-audit the whole pipeline as if the origin is hostile. Auth + entitlement gates were the only thing bounding abuse; removing them re-arms every latent DoS.

**Why:** The site-design extractor (`extractSiteSignals` → `readCapped`) read the whole response with `res.arrayBuffer()` and only sliced to `maxBytes` AFTER buffering; `safeFetch` clears its abort timeout once headers arrive, so the body read had no size limit and no deadline. A hostile origin that returns fast headers then streams gigabytes (or slow-drips forever) could OOM/hang the Node process in ONE unauthenticated request — per-IP and global rate limits don't help because a single request suffices. This was tolerable behind `verifyNostrAuth` + `requireProEntitlement`; it was not acceptable on the public `/convert` preview endpoint (`/api/storefront/preview-from-url`).

**How to apply:**

- Stream bodies via `res.body.getReader()`, accumulate up to `maxBytes`, then `reader.cancel()`. Never `arrayBuffer()`-then-slice on an attacker-controlled origin.
- The reader must own an overall read deadline, because `safeFetch`'s AbortController timeout is cleared once headers land — race each `read()` against a timer and cancel on timeout.
- Fix the SHARED helper (not the endpoint) so the still-authed caller is hardened too.
- Layer this UNDER, not instead of: a tight per-IP limit + a GLOBAL bucket (caps total LLM/compute spend against distributed abuse, checked only on cache miss) + a short-TTL per-URL cache (also makes a shared outreach link deterministic and avoids re-billing the model).
- SSRF is already handled inside `safeFetch` (per-redirect-hop private-IP rejection) — don't re-implement it at the endpoint.
