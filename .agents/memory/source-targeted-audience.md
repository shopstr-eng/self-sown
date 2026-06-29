---
name: Source-targeted email audience
description: How popup-vs-subscription source narrowing flows through the seller audience resolver and broadcast path
---

# Source-targeted email audience

`getSellerAudienceEmails(pubkey, source?)` narrows a seller's send to one
captured-contact origin.

**Rule:** when a `source` ("popup" | "subscription") is passed, the resolver
queries ONLY `popup_email_captures` of that source and DROPS the buyers union
(notification_emails joined to the seller's message_events). With no source it
returns the full set (buyers UNION every capture).

**Why:** buyers come from orders, not a capture form, so they carry no
popup/subscription origin. Including them in a source-targeted send would leak
people the seller never meant to segment.

**How to apply:** the blog broadcast path threads an optional `audienceSource`
(route `broadcast-blog-post.ts` → `runBlogBroadcast` → resolver). The route
validates it (only popup/subscription, no "all") and BINDS it into the
verifyNostrAuth fields, so a captured auth event can't be replayed to retarget
a different segment. The scheduled-publish cron intentionally omits it (full
audience). The flow send-to-contacts path does NOT use this resolver — it lists
`getPopupEmailCapturesBySeller` (which already returns `source`) and filters
client-side in the picker, sending explicit emails in the POST body.
