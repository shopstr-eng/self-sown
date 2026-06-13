---
name: Trackable email-flow CTA links
description: How custom email-flow links get click-tracked via a signed redirect, and the invariants that keep it safe and accurate.
---

Pro sellers' custom email flows can have CTA buttons/links that are click-tracked. Clicks route through a signed redirect, get recorded in Postgres, and surface as per-flow counts in settings.

**Rewrite happens AFTER render, only on the real send path.**

- `rewriteFlowEmailLinks(html, ctx)` runs in the flow processor AFTER `renderFlowEmail(...)` (which escapes merge-tag URLs) and before SendGrid send. `send-test` is intentionally left untracked.
- The rendered html has HTML-escaped attributes (e.g. `&amp;`), so the rewriter must DECODE entities before signing the destination and RE-ESCAPE after, or the signed dest won't match the real URL.
- The href matcher only targets double-quoted `<a href="...">` — that is what the editor and templates emit. Single-/unquoted raw-HTML hrefs are not tracked (accepted scope limitation, not a bug).

**Security invariants (do not regress):**

- The destination URL lives INSIDE the HMAC-signed token payload. The redirect endpoint must 302 only to that signed dest, NEVER to a query-supplied destination. Invalid/expired token → 302 to a safe fixed fallback. This is the open-redirect mitigation.
- Verify re-checks http/https only, max length (~2048), TTL (90 days), and uses `timingSafeEqual`.
- Click recording is best-effort and must not block the recipient's redirect.
- Replay can inflate counts — that's expected analytics behavior for reusable email links, not an auth boundary. Don't store IP/UA/recipient email/PII.

**No new secret needed:** HMAC key = `EMAIL_FLOW_CLICK_SECRET || FLOW_PROCESSOR_SECRET` (the latter is already configured).

**Why:** the after-render ordering + decode/re-escape dance and the "redirect only to signed dest" rule are the two non-obvious things that, if missed, silently break tracking or open a redirect vuln.
