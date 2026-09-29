---
name: Email template escaping contract
description: esc() in utils/email/email-templates.ts is the total sink for untyped data; never feed escapeHtml raw request/JSON values.
---

# Email template escaping contract

`esc()` in `utils/email/email-templates.ts` is intentionally total: strings
are HTML-escaped, numbers/booleans are stringified then escaped, and
objects/arrays/null/undefined become "". Template authors must route every
untyped value through `esc()` — never call `escapeHtml` directly on
request-derived or JSON-derived data — and must coerce BEFORE truthiness
checks (`esc(x) ? ... : fallback`), or an object field suppresses the
fallback and renders an empty slot.

API routes that feed templates must also coerce at the boundary
(asStr/asAmount pattern in `pages/api/email/send-order-email.ts`): a 500 in
the shared try block drops BOTH buyer and seller order emails.

**Why:** production incident — a numeric `amount` in the order-email POST
body crashed escapeHtml (`.replace is not a function`) and both order emails
were silently lost. The request body is untyped JSON; TS interfaces lie at
runtime.

**How to apply:** any new email-template field or any new route feeding
templates. Every email-template module now has a total coercion pair
(`esc`/`asString`): `email-templates.ts`, `flow-email-templates.ts`
(merge tags + shop name + style colors via guarded pickContrastColor), and
`blog-broadcast-email.ts` (post fields/URLs/shop name). New modules must
follow the same pattern rather than a bare `escapeHtml(str: string)`.
