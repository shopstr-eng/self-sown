---
name: Replit edge proxy XFF is single trusted hop
description: How production rate-limit per-client IP resolution behaves behind Replit's autoscale edge, verified live
---

Replit's autoscale edge proxy is a **single trusted hop**: it appends the real client IP as the _rightmost_ `x-forwarded-for` token. A client-supplied leftmost XFF cannot spoof or split the bucket — the edge appends the caller's real IP after it.

**Verified live against `https://milk.market/about` (agent-view, 600/min):**

- Sequential requests from one client decrement a per-client counter with zero gaps from other global traffic.
- First request of each 60s window starts fresh at `ratelimit-remaining: 599` / `ratelimit-reset: 60` (bucket keyed to that client, not a shared forwarder).
- A spoofed `x-forwarded-for: 203.0.113.99` keeps decrementing the SAME counter, not a fresh 599 — proving rightmost-token resolution and un-spoofability.

**Why:** confirms `TRUST_PROXY_HEADERS=true` + rightmost-XFF parsing in `getRequestIp` (`utils/rate-limit.ts`) isolates each agent's budget. The `x-real-ip` fallback is unnecessary here; no multi-hop shared internal IP appears as rightmost.

**How to apply:** trust the rightmost XFF token for client identity in this deployment; don't switch to `x-real-ip` or `TRUSTED_PROXY_IPS`. Note the production responses carry `cache-control: private` so the shared edge doesn't cache them — repeat requests reach origin and decrement normally.
