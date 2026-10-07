---
name: EAS mobile release gotchas
description: Cloud-build failure modes and credential conventions for EAS TestFlight/Play/APK releases of apps/mobile
---

Gotchas learned standing up EAS cloud builds (all cost failed builds to learn):

- **EAS workers evaluate app.config.ts without a TS transpiler.** `import type`, `as` casts, and type annotations die at READ_APP_CONFIG with "Unexpected token". Keep app.config.ts plain-JS-parseable (JSDoc types) and any file it imports (e.g. lib/api-configuration.js) plain CommonJS. Node ≥22 locally strips types so the failure is invisible locally.
  **Why:** local `node` + eas-cli accept TS configs; the worker doesn't.
- **credentials.json ios keys are Xcode target names, not bundle IDs.** For a managed Expo app the target is the sanitized app name (`SelfsownVendor`). A bundle-ID key passes local validation but the worker fails at CONFIGURE_XCODE_PROJECT with "Could not find target".
- **OpenSSL 3 p12 exports need legacy algorithms for EAS macOS workers:** `openssl pkcs12 -export -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg SHA1` or keychain import fails with "could not verify the PKCS#12 MAC".
- **Repo enforces GitHub immutable releases:** create the release as draft, upload assets, then PATCH draft:false. A deleted release's tag name stays burned forever — pick a fresh tag.
- **eas-cli flag drift:** `build`/`build:list` accept `--non-interactive`; `build:view` rejects it.
- **Legacy Expo robot tokens only authenticate as `EXPO_TOKEN` env var** (not `EXPO_ACCESS_TOKEN`); account `shopstr-markets`, project `0b827bc9-9288-4747-b7d3-b811bb384860`.
- **Neither Apple nor Google let APIs create the app record itself** — the ASC app (com.selfsown.mobile) and Play Console app must be created in their web UIs by a human; eas submit only works after that.

## Store submission notes (Oct 2026)
- Play Console no longer has "Setup → API access" (page removed). Grant the service account via Play Console → Users & permissions → Invite new users (service account email as the address; no acceptance needed). Permissions: "View app information (read-only)" + "Release apps to testing tracks" (+ "Manage production releases" if automating prod).
- The GCP project must ALSO have the Google Play Developer API enabled (console.cloud.google.com/apis/library/androidpublisher.googleapis.com) or fastlane supply fails PERMISSION_DENIED.
- `eas submit` iOS requires ascAppId in eas.json once the ASC app record exists; look it up with GET /v1/apps?filter[bundleId]=... via the ASC API key (script pattern in scripts/provision-ios-credentials.mjs).
- iOS submit IPA upload can run 20-30 min with no incremental log output — it's not hung; poll the process, not the log.

## Firebase/FCM wiring (Oct 2026)
- google-services.json lives in apps/mobile/keys/ (git-ignored) and is uploaded as an EAS file-type env var `GOOGLE_SERVICES_JSON` scoped to the **production** environment ONLY — the staging package (com.selfsown.mobile.staging) is not registered in Firebase, so preview/dev profiles must not see it. app.config.ts gates `googleServicesFile` on the env var; EAS materializes file-type vars on the worker and the env value is the file path (exactly what googleServicesFile expects).
- google-services.json only configures the CLIENT. Expo push delivery (server → exp.host → FCM) needs the FCM v1 **service-account key** (Firebase console → Project settings → Service accounts → Generate new private key — a different JSON) uploaded to EAS credentials.
- Builds made before this wiring (Android build 6, the first Play submission) have no FCM config — push is dead in them; build 7+ carries it.
