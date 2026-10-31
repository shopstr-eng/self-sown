---
name: Custom-domain status auto-advance
description: custom_domains lifecycle statuses self-converge on dashboard views via utils/custom-domain-lifecycle.ts — forward-only, no cron; add new states there, not in routes.
---

Custom-domain statuses (`pending_dns → dns_verified → active`) advance automatically when the admin domains list or the seller's own `GET /api/storefront/custom-domain` is loaded, via `advanceCustomDomainStatus` in `utils/custom-domain-lifecycle.ts`. The DNS check (`checkDomainDns`) is shared with the verify route so the button and the background transition can't disagree.

**Why:** There is no Replit API to attach a domain to a deployment, so "attached" was split from "active": cert-pending isn't externally observable, so auto-advance jumps straight to `active` once the TLS probe passes. Forward-only (probes never demote; `active`/`failed` rows are never probed) because a transient outage must not take a live domain backwards, and `failed` is an admin-set terminal state. View-triggered instead of cron because every status display surface already loads through these two routes.

**How to apply:** New lifecycle states or transitions belong in `advanceCustomDomainStatus`, not in individual routes. The admin dropdown (`/api/admin/custom-domains/status`) is the manual override — never remove it. When mocking in tests, mock `@/utils/custom-domain-lifecycle` in endpoint tests (it's unit-tested on its own) or DNS/TLS network calls escape into the suite.
