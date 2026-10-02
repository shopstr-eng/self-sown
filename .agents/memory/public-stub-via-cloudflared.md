---
name: Public https URL for a local stub server
description: the dev domain resolves to a private IP inside the container (SSRF guard rejects hairpin URLs); a cloudflared quick tunnel gives a free public https URL for a locally-running stub
---

When server code must call a stub you run locally (e.g. a fake LNbits node for
the x402 seller-authority path), the obvious hairpin — https://$REPLIT_DEV_DOMAIN
pointing back at the container — FAILS the SSRF guard: inside the container the
dev domain resolves to a private 172.24.x.x address (split-horizon DNS), so
utils/url-safety isSafePublicHostname rejects it. /etc/hosts is read-only, and
IP-wildcard DNS (nip.io/sslip.io) aimed at the edge's public IP fails TLS
(the Replit edge only serves its own names via SNI).

What works: a Cloudflare quick tunnel — no account needed:
`curl -sSL -o /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64`
then `/tmp/cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`
prints a random https://\*.trycloudflare.com URL that resolves publicly, passes
the SSRF guard, and forwards to the local stub. URL changes per run.

**Why:** discovered building the x402 external E2E; two simpler approaches
(hairpin domain, /etc/hosts, nip.io) each failed for a distinct reason.
**How to apply:** any time app server code must fetch a URL you control in
this dev container, give the stub a quick-tunnel URL instead of the dev
domain. Note the dev app itself IS publicly reachable at
https://$REPLIT_DEV_DOMAIN:5000 (port 443 maps to local 3000, not the app's 5000) for client-side/external-caller purposes.
