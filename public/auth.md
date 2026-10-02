# Agent Authentication (auth.md)

Self-sown implements the agent-auth flow described at
https://github.com/workos/auth.md. An agent obtains a service-signed
identity assertion, exchanges it for an access token, and calls the API with
that token. The access token is a standard Self-sown API key — the same
credential issued by `POST /api/mcp/onboard` — so every step of this flow is
verifiably live.

All endpoints are relative to the origin you are calling (platform:
https://self-sown.com). Discovery metadata
(`/.well-known/oauth-authorization-server` and
`/.well-known/oauth-protected-resource`) is host-derived, so the flow works
identically on the platform site and on seller custom domains.

## 1. Discover

```
GET /.well-known/oauth-protected-resource      (RFC 9728 — scopes + AS link)
GET /.well-known/oauth-authorization-server    (RFC 8414 — endpoints + agent_auth)
```

## 2. Obtain an identity assertion

```
POST /api/agent/identity
Content-Type: application/json

{ "type": "anonymous", "name": "my-agent" }
```

`type` is one of the values in `agent_auth.identity_types_supported`:

- `anonymous` — no proof required. The server generates a fresh Nostr keypair
  and binds the assertion to its public key.
- `service_auth` — prove control of an existing Nostr identity: send
  `pubkey` (64-char hex) plus `signedEvent`, a signed kind-27235 Nostr event
  (max 5 minutes old) with tags `action=agent-identity`, `method=POST`,
  `path=/api/agent/identity`, `pubkey=<your pubkey>`.

The response contains `identity_assertion` (HS256 JWT, 10-minute TTL) and the
`pubkey` the eventual API key will belong to.

## 3. Exchange the assertion for an access token

```
POST /api/oauth2/token
Content-Type: application/json

{
  "grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer",
  "assertion": "<identity_assertion>"
}
```

Response: `{ "access_token": "ss_...", "token_type": "Bearer", "scope": "shopping" }`.
Failures use the RFC 6749 error shape (`invalid_request`, `invalid_grant`,
`unsupported_grant_type`).

## 4. Call the API

```
Authorization: Bearer ss_...
```

Works against `/api/mcp` (MCP Streamable HTTP) and the UCP commerce
endpoints. The issued key has the `shopping` scope: catalog search/lookup
plus purchase tooling. Seller (shop-management) keys are issued through
`POST /api/mcp/onboard` with `audience: "seller"` and require the pubkey to
hold an active shop membership.

## 5. Revoke

```
POST /api/oauth2/token → revoked via:
POST /api/oauth2/revoke
Content-Type: application/json

{ "token": "ss_..." }
```

RFC 7009 semantics: the endpoint returns 200 whether or not the token
existed, and possession of the token is the authority to revoke it.

## Rate limits

Identity, token, and revocation endpoints enforce 30 requests/minute per IP
and return RFC RateLimit headers (`RateLimit-Limit`, `RateLimit-Remaining`,
`RateLimit-Reset`, `RateLimit-Policy`) on every response, with `Retry-After`
on HTTP 429. The MCP protocol endpoint budgets are published in `agents.txt`.
