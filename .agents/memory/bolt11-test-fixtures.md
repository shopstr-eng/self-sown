---
name: bolt11 test fixtures
description: How to generate real bolt11 invoice fixtures for tests; @getalby/lightning-tools decodeInvoice rejects BOLT-11 spec vectors.
---

To create real, decodable bolt11 invoice fixtures for Jest tests: use the Python `bolt11` package in a scratch venv (`python3 -m venv /tmp/bolt11-venv`, install with `PIP_CONFIG_FILE=/dev/null PIP_USER=0` and PYTHONPATH scrubbed, per the staging-mint gotchas), build a `Bolt11` with payment_hash + payment_secret + description tags (payment_secret is mandatory or encode throws), optionally an `expire_time` tag, then `encode(b, private_key="01"*32)`.

**Why:** `@getalby/lightning-tools` `decodeInvoice` (used server-side for invoice expiry) returns `null` for the old BOLT-11 spec test vectors — its decoder swallows errors, so spec vectors can't serve as fixtures. A locally signed invoice decodes cleanly and lets tests pin exact timestamp+expiry values.

**How to apply:** any test needing a decodable bolt11 string (invoice expiry, amount parsing, payment-hash checks). Also note `decodeInvoice` never throws — it returns `null` on any decode failure, so callers must null-check.
