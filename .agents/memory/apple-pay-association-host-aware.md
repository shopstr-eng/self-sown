---
name: Apple Pay registration (Stripe PMD) + Square association file
description: Stripe Apple Pay registers via the Payment Method Domain API with no hosted file; the well-known route serves Square's file only for Square-connected sellers' domains; the marketplace host stays off.
---

Stripe (per current docs): register each checkout domain per charge-owning account via payment_method_domains.create (+ validate when create returns an id); Stripe handles Apple's merchant validation — no association file is hosted by us or sellers. The legacy apple_pay/domains API is deliberately not called. Apple Pay stays OFF the marketplace host: its platform-account PMD is disabled at Stripe (enabled=false is the real off switch — 404ing a file does nothing) and trustedRegistrationHost never registers it. Legacy connected-account PMDs for the marketplace host are swept by scripts/sweep-marketplace-apple-pay-pmds.ts (idempotent, report-only by default, --apply to disable); it must be re-run against the production database after deploy — the dev DB sweep is not sufficient.

Square's flow is two-part: the association file AND POST /v2/apple-pay/domains activation. The file route serves Square's file ONLY for self-host instances and verified custom domains whose seller is Square-connected; everything else 404s, DB outages 503.

Activation design rules (hard-won): authenticate as the PLATFORM via SQUARE_ACCESS_TOKEN (Developer Dashboard access token, NOT the OAuth client secret or a seller OAuth token); feature no-ops when unset. The lazy trigger must live on the PRE-SDK seller-status route — the charge route is only reachable after payments.applePay() succeeds, so a post-SDK trigger can never bootstrap a hidden button. Cache ONLY an explicit VERIFIED response status; PENDING and even "already registered" duplicates are not proof Apple finished validating, and Square offers no status re-check endpoint, so anything non-VERIFIED must stay retryable. Any inline-awaited activation call needs an abort timeout — a stalled Square API must not hold card payments hostage.

**Why:** Stripe's PMD flow replaced file-based verification (user supplied the platform pmd id to disable, 2026-09); Square's API reference still requires the hosted file.

**How to apply:** never re-add a Stripe branch to the well-known route or re-admit the platform host in trustedRegistrationHost; to toggle Apple Pay on a domain, enable/disable the PMD per account. Dev quirk: the dev workflow's base URL is the canonical production domain, so Host-header curls exercise the platform branch. APPLE_PAY_DOMAIN_ASSOCIATION (Stripe file) is now unreferenced and can be deleted; SQUARE_APPLE_PAY_DOMAIN_ASSOCIATION remains live.
