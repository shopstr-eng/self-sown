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
- Registration challenge is sent inline during `requestChallenge` (no scheduler needed for enablement). Activity pushes dispatch via an **in-process scheduler** (startMobilePushScheduler in utils/notifications/scheduler.ts, started from instrumentation.ts, 60s tick, overlap-guarded) that POSTs /api/mobile/notifications/process with the Bearer processor secret — no external cron exists or is needed. It only starts when MOBILE_SELLER_PUSH_ENABLED=true + MOBILE_PUSH_PROCESSOR_SECRET are set; the endpoint re-checks auth+flag per call, so rollback = flip the flag and restart.
- Expo push delivery additionally needs FCM v1 (Android) / APNs (iOS) credentials on the Expo project. Android FCM v1 is DONE (googleServiceAccountKeyForFcmV1 already set on the prod com.selfsown.mobile androidAppCredentials; staging intentionally has none).
- GraphQL credential API DOES work with `Authorization: Bearer $EXPO_ACCESS_TOKEN` (an earlier "403 on credential queries" claim was wrong — the failures were bad field names). iOS creds were stood up via API 2026-10-15: createAppleTeam → createAppleAppIdentifier(com.selfsown.mobile) → createIosAppCredentials. Gotcha: AppleAppIdentifierInput.appleTeamId wants the Expo-internal AppleTeam UUID (from createAppleTeam), not the Apple team-identifier string, else "Entity field not valid: AppleTeamEntity".
- The existing APPLE_PRIVATE_KEY (Sign-in-with-Apple key) is NOT APNs-enabled — probed api.sandbox.push.apple.com over node:http2 with normalized PEM + ES256 JWT → 403 InvalidProviderToken (a 400 BadDeviceToken response = key IS APNs-enabled; that's the live verification pattern).
- iOS push credentials COMPLETE 2026-10-15: dedicated APNs Auth Key (Key ID 5L9CBCT9SF, secrets APNS_AUTH_KEY_P8/APNS_AUTH_KEY_ID) uploaded via applePushKey.createApplePushKey + iosAppCredentials.setPushKey onto creds id 303443f1-26f8-4dfb-9c55-266cd6dbfc69. Pasted .p8 needed newline re-wrap before upload (see pem-secrets-collapse-newlines). Both platforms' push credentials are now on the Expo project.

## Enable-flow hang fix

First real-device test: "Enable alerts" spun forever with no permission prompt. Cause: native Expo calls in the enable path (getPermissionsAsync/requestPermissionsAsync/setNotificationChannelAsync/getExpoPushTokenAsync) had no timeout, and getExpoPushTokenAsync never settles on builds without push credentials baked in (Android: GOOGLE_SERVICES_JSON must be set at EAS build time). All four are now wrapped in withNativeTimeout so the flow fails loudly naming the step. **No OTA updates are configured** (no runtimeVersion/updates in eas.json/app.config.ts) — JS-only fixes like this reach devices only via a new EAS build.

## v0.3.3 release state (2026-10-16)

- v0.3.3 = the two mobile fixes (enable-alerts native-call timeouts; Stripe checkout fixed-string deep link instead of Linking.createURL). Pushed to origin/main.
- iOS v0.3.3 build 17 SUBMITTED to TestFlight (App Store Connect processing).
- Android NOT shipped: Expo free-plan monthly Android build quota exhausted, resets 2026-11-01 — user chose to wait. On/after Nov 1: eas build android (production AAB + production-apk), eas submit android (Play internal track), zsp publish the APK to Zapstore, and GitHub release `mobile-v0.3.3` with asset `self-sown-v0.3.3.apk` (draft → attach → undraft; immutable releases burn tag names).
- zsp v0.4.17 installed at ~/bin/zsp (needs re-download on fresh containers); zapstore.yaml already at repo root.
- Still owed regardless: web app REPUBLISH (push flag/secrets + any server-side fixes only ship then) and real-device verification of both fixes.
