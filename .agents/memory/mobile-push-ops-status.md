---
name: Mobile push alerts ops status
description: Seller push alerts need 4 server env vars + republish + per-minute scheduler; enabled in prod 2026-10-14, scheduler wiring is the remaining piece.
---

# Mobile seller push alerts — operational status

The in-app "Enable alerts" flow (added with phase-6 seller alerts) is gated server-side by `MOBILE_SELLER_PUSH_ENABLED` (checked in `utils/notifications/runtime.ts`). When off, the challenge endpoint returns 503 "Seller notifications are not enabled" and the app misleadingly shows "Alerts could not be enabled. Check your connection and retry." (follow-up exists to improve that message).

**Why:** The mobile feature shipped in v0.3.x but the server config was never set, so every enable attempt failed at the first API call — diagnosed 2026-10-14 via a signed NIP-98 probe against prod.

**How to apply / state as of 2026-10-14:**
- Set in production env: `MOBILE_SELLER_PUSH_ENABLED=true`, `MOBILE_PUSH_DEPLOYMENT=production`; secrets `MOBILE_PUSH_TOKEN_ENCRYPTION_KEY` + `MOBILE_PUSH_PROCESSOR_SECRET` added. `EXPO_ACCESS_TOKEN` already existed.
- Env/secret changes require a **republish** to reach the live deployment (verified: prod kept returning 503 until republish).
- Registration challenge is sent inline during `requestChallenge` (no scheduler needed for enablement), but **activity pushes dispatch only via** `POST /api/mobile/notifications/process` with `Authorization: Bearer $MOBILE_PUSH_PROCESSOR_SECRET`, ~once/minute (docs/mobile/seller-alerts.md). If pushes never arrive but enablement works, the scheduler is the gap.
- Expo push delivery additionally needs FCM v1 (Android) / APNs (iOS) credentials on the Expo project; the EXPO_ACCESS_TOKEN robot token gets 403 on GraphQL credential queries, so verify push credentials in the Expo dashboard, not via API.
