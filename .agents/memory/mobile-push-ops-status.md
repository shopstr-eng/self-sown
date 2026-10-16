---
name: Mobile push alerts ops status
description: Seller push alerts need 4 server env vars + republish + per-minute scheduler; enabled in prod 2026-10-14, scheduler wiring is the remaining piece.
---

# Mobile seller push alerts — operational status

The in-app "Enable alerts" flow (added with phase-6 seller alerts) is gated server-side by `MOBILE_SELLER_PUSH_ENABLED` (checked in `utils/notifications/runtime.ts`). When off, the challenge endpoint returns 503 "Seller notifications are not enabled" and the app misleadingly shows "Alerts could not be enabled. Check your connection and retry." (follow-up exists to improve that message).

**Why:** The mobile feature shipped in v0.3.x but the server config was never set, so every enable attempt failed at the first API call — diagnosed 2026-10-14 via a signed NIP-98 probe against prod.

**How to apply / state as of 2026-10-14:**
- Set in production env: `MOBILE_SELLER_PUSH_ENABLED=true`, `MOBILE_PUSH_DEPLOYMENT=production`; secrets `MOBILE_PUSH_TOKEN_ENCRYPTION_KEY` + `MOBILE_PUSH_PROCESSOR_SECRET` added. `EXPO_ACCESS_TOKEN` already existed. Same vars set in development env with `MOBILE_PUSH_DEPLOYMENT=development`.
- The first encryption key entered decoded to 29 bytes → runtime init threw → 503 "Notification service is temporarily unavailable". The key MUST decode to exactly 32 bytes; validate before assuming a different bug.
- Env/secret changes require a **republish** to reach the live deployment; dev picks them up only after restarting the Next.js Dev Server workflow.
- Dev verified end-to-end 2026-10-14: signed NIP-98 challenge probe passes flag/runtime/DB and reaches Expo, which rejects the fake probe token with DeviceNotRegistered (expected; direct curl to exp.host with EXPO_ACCESS_TOKEN confirms the token authenticates).
- Registration challenge is sent inline during `requestChallenge` (no scheduler needed for enablement), but **activity pushes dispatch only via** `POST /api/mobile/notifications/process` with `Authorization: Bearer $MOBILE_PUSH_PROCESSOR_SECRET`, ~once/minute (docs/mobile/seller-alerts.md). If pushes never arrive but enablement works, the scheduler is the gap.
- Expo push delivery additionally needs FCM v1 (Android) / APNs (iOS) credentials on the Expo project. Android FCM v1 is DONE (googleServiceAccountKeyForFcmV1 already set on the prod com.selfsown.mobile androidAppCredentials; staging intentionally has none).
- GraphQL credential API DOES work with `Authorization: Bearer $EXPO_ACCESS_TOKEN` (an earlier "403 on credential queries" claim was wrong — the failures were bad field names). iOS creds were stood up via API 2026-10-15: createAppleTeam → createAppleAppIdentifier(com.selfsown.mobile) → createIosAppCredentials. Gotcha: AppleAppIdentifierInput.appleTeamId wants the Expo-internal AppleTeam UUID (from createAppleTeam), not the Apple team-identifier string, else "Entity field not valid: AppleTeamEntity".
- The existing APPLE_PRIVATE_KEY (Sign-in-with-Apple key) is NOT APNs-enabled — probed api.sandbox.push.apple.com over node:http2 with normalized PEM + ES256 JWT → 403 InvalidProviderToken. A dedicated APNs Auth Key is required; upload via applePushKey.createApplePushKey(accountId, {keyP8, keyIdentifier, appleTeamId: <AppleTeam UUID>}) then iosAppCredentials.setPushKey(<iosAppCredentials id>, pushKeyId). Pasted .p8 needs newline re-wrap before upload (see pem-secrets-collapse-newlines).
