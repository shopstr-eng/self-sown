---
name: Apple Pay registration (Stripe PMD) + Square association file
description: Stripe Apple Pay registers via the Payment Method Domain API with no hosted file; the well-known route serves Square's file only for Square-connected sellers' domains; the marketplace host stays off.
---

Stripe (per current docs): register each checkout domain per charge-owning account via payment_method_domains.create (+ validate when create returns an id); Stripe handles Apple's merchant validation — no association file is hosted by us or sellers. The legacy apple_pay/domains API is deliberately not called. Apple Pay stays OFF the marketplace host: its platform-account PMD is disabled at Stripe (enabled=false is the real off switch — 404ing a file does nothing) and trustedRegistrationHost never registers it. Existing connected-account PMDs for the platform domain were NOT swept.

Square still verifies domains by fetching /.well-known/apple-developer-merchantid-domain-association, so that route serves Square's file ONLY for self-host instances and verified custom domains whose seller is Square-connected; everything else 404s, DB outages 503.

**Why:** Stripe's PMD flow replaced file-based verification (user supplied the platform pmd id to disable, 2026-09); Square's API reference still requires the hosted file.

**How to apply:** never re-add a Stripe branch to the well-known route or re-admit the platform host in trustedRegistrationHost; to toggle Apple Pay on a domain, enable/disable the PMD per account. Dev quirk: the dev workflow's base URL is the canonical production domain, so Host-header curls exercise the platform branch. APPLE_PAY_DOMAIN_ASSOCIATION (Stripe file) is now unreferenced and can be deleted; SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION remains live.
