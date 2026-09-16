---
name: Apple Pay domain-association routing
description: the Apple Pay association route is host-aware and the marketplace host intentionally 404s — Apple Pay is marketplace-off by product decision.
---

Each processor (Stripe, Square) has its own Apple Pay domain-association file and Apple fetches one fixed well-known path, so a domain can verify with exactly one processor. The route 404s the platform marketplace host (product decision: no Apple Pay on the general marketplace), serves the seller's connected-processor file on verified custom domains, serves the operator-configured file on self-host, and fails closed (404/503) otherwise — never serve one processor's file for another's domain.

**Why:** hosting Square's file on the marketplace domain would have silently broken Stripe's re-verification there; the user chose marketplace-off instead (2026-09).

**How to apply:** trustedRegistrationHost must never re-admit the hosted platform host; self-host instances are detected via the SS_SELF_HOST env gate (their own base URL IS their domain, so base-URL comparisons must be self-host-aware). Dev quirk: the dev workflow's base URL is the canonical production domain (Host-header curls against it exercise the platform branch) and the Stripe file env is production-only, so the dev fallback serves the Square file.
