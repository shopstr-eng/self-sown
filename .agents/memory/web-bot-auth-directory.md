---
name: Web Bot Auth signature directory
description: How the HTTP Message Signatures key directory is published and routed, plus the gotchas (ephemeral key default, media type via res.send, dual-host routing).
---

# Web Bot Auth: HTTP Message Signatures key directory

Milk Market publishes an Ed25519 public-key JWK Set at
`/.well-known/http-message-signatures-directory` so agents can discover the
platform's signing identity (Web Bot Auth /
draft-meunier-http-message-signatures-directory). Same canonical directory is
served on the platform host AND on seller custom domains.

## Routing gotcha (dual host)

The directory rewrite must sit at the TOP of `proxy()` (alongside the
`/.well-known/agent.json` block, before the `www` redirect and before the
`isCustomDomain` branch) so a single block covers both the platform host and
custom domains. If placed inside the custom-domain branch it would get rewritten
under `/stall/<slug>/...` and break. A `next.config.mjs` rewrite is added too as
a belt-and-suspenders for direct platform-host hits.

## Key source

`utils/web-bot-auth/keys.ts` loads `WEB_BOT_AUTH_ED25519_PRIVATE_KEY`
(base64 PKCS#8 DER or PEM); if absent/malformed it auto-generates an Ed25519
keypair memoized per process. So the published `kid` (= RFC 7638 JWK thumbprint)
ROTATES on every restart/redeploy unless the env var is set.
**Why:** verifiers cache directories by kid; for a stable prod identity the
operator must run `scripts/generate-web-bot-auth-key.mjs` and store the printed
private key as a secret. Agent does not set this secret automatically (sensitive).

## res.send vs res.json gotcha

`res.json()` forces `Content-Type: application/json` and clobbers the registered
`application/http-message-signatures-directory+json` media type. Use
`res.setHeader(...); res.send(JSON.stringify(directory))` instead.

## Two different algorithm identifiers

The published JWK `alg` must be `EdDSA` (JOSE/RFC 8037 label for Ed25519 keys),
NOT `Ed25519`. The HTTP Message Signatures algorithm label is the separate
lowercase `ed25519` (RFC 9421) — that one belongs in the discovery JSON
(mcp.json / agent-card.json), not in the JWK. Mixing them up breaks strict
verifiers.
