# Seller activity alerts

Phase 6 is stacked on `feature/phase-5-seller-shipping-mobile` until PR #33 merges. The numbered mobile PR sequence is separate from the calendar roadmap. This document describes operation and verification of the implementation; it is not the external phase plan or specification.

## Behavior and privacy

Sellers explicitly enable alerts in the dashboard. Registration proves possession of both the seller signing key and a push-delivered, five-minute, single-use device challenge. Keep the app open during verification. A token alone cannot move another installation's registration. Tokens are encrypted at rest; nonce and device revocation secrets are hashed on the server. Device lists expose only platform, enabled state, and last activity time.

One installation has one active seller per API deployment. Signing out queues device-only revocation before removing the seller session. Offline cleanup retains no seller signing key or signed request. A generic alert already accepted by the provider can still arrive after logout; opening it never authorizes access to an order. The API rechecks the signed-in seller, and the app decrypts and validates orders before selecting a detail route. Unknown or unauthorized activity cannot reveal another seller's details. Ambiguous activity opens Orders. Foreground notifications refresh data without a system banner or raw-message OS badge.

The cache's first insertion of a kind-1059 event records an immutable activity marker. Existing rows are not backfilled, repeated cache updates do not generate another marker, and workers reconcile markers without a timestamp cursor. Only messages received by this deployment are covered. The worker verifies the outer signature and recipient routing; it cannot establish an order or payment from encrypted outer metadata.

Visible push text is always “Milk Market” / “New seller activity. Open the app to review.” Its data is exactly `{version: 1, type: "seller_activity", activityId: <opaque UUID>}`. No buyer information, order contents, keys, or arbitrary navigation URL appears in that payload.

## Server configuration

| Variable                           | Purpose                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `MOBILE_SELLER_PUSH_ENABLED`       | Exact `true` enables challenge/confirmation and worker sends. Leave unset during initial rollout. |
| `MOBILE_PUSH_DEPLOYMENT`           | Stable deployment identifier, 1–64 letters, digits, underscores or hyphens.                       |
| `MOBILE_PUSH_TOKEN_ENCRYPTION_KEY` | Canonical base64 encoding of 32 random bytes. Keep in server secret storage.                      |
| `EXPO_ACCESS_TOKEN`                | Expo push access token; configure enhanced push security for the corresponding project.           |
| `MOBILE_PUSH_PROCESSOR_SECRET`     | At least 32 characters; used only by the scheduler as a Bearer credential.                        |

Do not prefix these secrets with `EXPO_PUBLIC`. Changing the encryption key requires re-registering affected devices; retain the key when temporarily disabling delivery so device revocation remains available.

A scheduler must POST `/api/mobile/notifications/process` approximately once per minute with `Authorization: Bearer <processor secret>`. Configure a 60-second request budget. No new scheduler is deployed automatically by this PR. The endpoint stops claiming work for dispatch after its internal time budget; abandoned leases recover after two minutes. Overlapping invocations use database leases and per-device reservations. Provider I/O never holds a database transaction open.

The worker reserves at most one visible send per device per 60 seconds and 12 per rolling hour, including uncertain attempts. Accepted activity covers older burst jobs. Retry delays are 1, 5, 15, 60, then 180 minutes, respecting longer provider Retry-After values, bounded by source age of 24 hours. Push receipts are checked after 15 minutes. Tickets mean Expo acceptance; receipts mean provider acceptance, neither means the user saw the alert. Unknown network outcomes can still duplicate an external delivery. Invalid-token results disable only the generation that produced them.

Expired challenges are pruned after 24 hours, activity after 30 days, and devices inactive for 90 days. Processing returns redacted counts. Monitor delivery status counts, source age, receipt lag, and invalid devices in PostgreSQL; never log tokens or full provider responses. During a staged pilot, enable only the designated deployment and test accounts before inviting additional sellers. A public rollout is a separate decision.

Rollback: set `MOBILE_SELLER_PUSH_ENABLED=false` and stop the scheduler. Keep additive tables and encryption configuration for revocation. Core seller orders and shipping remain usable.

## Native build configuration

`apps/mobile/eas.json` defines development, preview, and production profiles. Supply the real `EAS_PROJECT_ID` and `EXPO_PUBLIC_API_BASE_URL` in the selected EAS environment. Preview and production require a public HTTPS API URL and project ID. Release bundles also reject implicit localhost/emulator API fallback. Preview uses `com.milkmarket.mobile.staging` to isolate it from production.

Configure APNs and FCM credentials in the project, and inject the Android `GOOGLE_SERVICES_JSON` file through the build environment. Never commit that credential file. Physical-device staging validation, signed beta artifact creation, tester distribution, and store publication are separate gates. Simulator or mocked-provider results do not satisfy actual APNs/FCM delivery acceptance.

References: [Expo SDK 55 notifications](https://docs.expo.dev/versions/v55.0.0/sdk/notifications/) and [push setup](https://docs.expo.dev/push-notifications/push-notifications-setup/).
