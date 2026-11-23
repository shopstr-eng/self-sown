# Tap to Pay App Store submission — handoff

This folder holds the Tap to Pay review package for the Self-sown iOS app
(`com.selfsown.mobile`). The build, TestFlight upload, and every API-settable
listing field are done. What remains are three steps that require a human at a
device or in the App Store Connect web UI, plus one command each for the API
work around them.

## Current blockers (verified against App Store Connect)

`pnpm --filter @self-sown/mobile appstore:status` reports exactly what Apple
still requires for version 1.0. As of now:

- App screenshots: an **iPhone 6.9" (Dynamic Island)** set and an **iPad 13"**
  set (the build has `supportsTablet: true`, so both are mandatory).
- **App Privacy / data usages** published in the web UI (no public API can set
  these).
- The Tap to Pay walkthrough video attached to the review detail.

## Step 1 — Capture screenshots on a device or simulator

Capture real app screenshots from the shipping build and export them at Apple's
accepted sizes:

- iPhone 6.9" (Dynamic Island): `1290x2796` or `1320x2868`
- iPad 13": `2048x2732` or `2064x2752`

Put them in one folder (any filenames; PNG or JPEG). The uploader reads each
image's dimensions and sorts it into the right set, and refuses to upload a file
that is not an accepted size.

```sh
pnpm --filter @self-sown/mobile appstore:screenshots -- --dir ./appstore-screenshots
```

Add `--replace` only to overwrite screenshots already on the listing.

## Step 2 — Publish App Privacy in the web UI

App Store Connect → your app → **App Privacy** → **Get Started / Edit**, answer
the data-collection questionnaire, and **Publish**. Apple exposes no public API
for `appDataUsages`; this is web-UI only. (Re-running `appstore:status` after
publishing confirms the `APP_DATA_USAGES_REQUIRED` blocker is gone.)

The answers to give are drafted, with evidence, in
[`app-privacy-answers.md`](./app-privacy-answers.md) — category,
collected/linked/tracking, and the code path behind each one. Review it before
publishing, since the declaration is yours to make.

## Step 3 — Attach the walkthrough video and submit

Record the tap walkthrough on a physical iPhone with a second device filming the
Tap to Pay UI (shot list: `docs/apple-review/tap-to-pay-walkthrough.html`), then:

```sh
# attach the video to App Review information
pnpm --filter @self-sown/mobile appstore:attachment -- --file ./tap-walkthrough.mp4

# confirm nothing is left, then submit version 1.0
pnpm --filter @self-sown/mobile appstore:status
pnpm --filter @self-sown/mobile appstore:submit -- --version 1.0
```

`appstore:status` is safe to run any time — it stages the version on the app's existing draft review submission (App Store Connect does not allow deleting those, so the CLI always reuses the draft rather than creating new ones) and reads back what Apple still requires. `appstore:submit` aborts if anything is still missing.

## If Apple rejects asking for details

Reply on the rejection message thread in App Store Connect → your app → App
Review. The reviewer demo account (a seller nsec with Stripe card charges
enabled) and the review contact are already saved in the version's App Review
information, and the review notes quote the walkthrough.

## Requirements

`APP_STORE_CONNECT_KEY_ID`, `APP_STORE_CONNECT_ISSUER_ID`, and the ES256 key
(`apps/mobile/keys/asc-key.p8`, or `APP_STORE_CONNECT_PRIVATE_KEY`).
