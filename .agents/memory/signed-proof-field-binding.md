---
name: Signed-proof field binding (subset matcher)
description: Any request field that changes server-side behavior must be bound into the EXPECTED signed-proof shape, or the subset tag matcher lets it be swapped in a replay.
---

# Signed-proof field binding

`matchesMcpRequestProof` (utils/mcp/request-proof.ts) is a **subset matcher**: every
expected tag must appear in the signed event, but extra signed tags are ignored and
missing expectations are the only failures. So the security boundary is exactly the
set of fields the server puts into the expected proof.

**Rule:** when a request gains a new field that changes what the server does
(audience, mode, tier, target, amount...), the expected proof must bind THAT field
for requests that carry it — typically by switching the proof's field set on the
field's presence (`fields = audience !== undefined ? {name, audience, contact} : {name, permissions, contact}`), never by just adding it alongside, and never by
leaving the legacy shape unchanged for the new-style request.

**Why:** during the shopping/seller audience split, the onboard proof bound only
{name, permissions, contact}. A legacy owner signature for a `read` key could be
replayed with `audience: "shopping"` substituted in the request body, minting a
purchase-capable key the owner never authorized. Caught in architect review, not by
tests. Same class as the stripe-connect generic-fallback replay vector.

**How to apply:** when editing any `build*Proof` caller or the verifier, (1) list
which request fields the handler acts on, (2) confirm each is either inside the
expected proof fields or provably derived from bound fields, (3) regression-test
BOTH replay directions through the real `matchesMcpRequestProof` (legacy-signed vs
modern-expected and vice versa), not just field shapes.
