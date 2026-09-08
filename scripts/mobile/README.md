# Local mobile verification

Requires Node >=22.22, pnpm 10.26.1, Docker, and Xcode with an iOS Simulator. Android native verification additionally requires a JDK, Android SDK, and emulator/device. Use synthetic accounts only. These scripts never belong in a production startup command.

## API and database

From the repository root:

```sh
pnpm install --frozen-lockfile
docker compose -p milk-mobile-phase6 -f scripts/mobile/compose.yml up -d --wait
export MILK_MOBILE_LOCAL_FIXTURES=1
export MILK_MOBILE_FIXTURE_DIR="$(mktemp -d /tmp/milk-mobile-fixtures.XXXXXX)"
export DATABASE_URL=postgres://milk_mobile:milk_mobile_local@127.0.0.1:55436/milk_mobile
export MOBILE_SELLER_PUSH_ENABLED=true
export MOBILE_PUSH_DEPLOYMENT=local-test
export MOBILE_PUSH_TOKEN_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
export EXPO_ACCESS_TOKEN=local-fixture-token
export MOBILE_PUSH_PROCESSOR_SECRET=local-fixture-processor-secret-0001
export STRIPE_SECRET_KEY=sk_test_local_fixture
export SHIPPO_OAUTH_CLIENT_ID=local-fixture-client
export SHIPPO_OAUTH_CLIENT_SECRET=local-fixture-secret
node --require ./scripts/mobile/fixture-provider.cjs ./node_modules/next/dist/bin/next dev -H 127.0.0.1 -p 5000
```

The all-zero encryption key and fixed seller keys are test fixtures, never deployment values. Keep the same environment in other test terminals. The provider preload refuses a non-fixture database URL, captures pushes and shipping requests locally, and blocks Stripe/Shippo/Expo network sends. It is never imported by production application code.

Once the API is ready:

```sh
node scripts/mobile/seed.cjs
node scripts/mobile/verify-push.cjs
node scripts/mobile/relay.cjs
```

Seeding first initializes the real runtime schema. `fixture.json` contains the synthetic seller nsec for simulator sign-in. `verify-push.cjs` tests real HTTP signatures, possession challenge, replay rejection, queue dispatch, opaque payload, and wrong-seller denial. It produces `activity.apns` for simulator injection. Use a fresh fixture database and directory for a repeat verification run: the script intentionally expects one initial delivery, rather than silently erasing earlier evidence. Remove only this named Compose project when finished; no external database is used.

## Isolated native workspace

```sh
node scripts/mobile/prepare-native.mjs ios --fixtures
```

The script prints `NATIVE_WORKSPACE`. It copies tracked and untracked source into a fresh temporary directory and links the installed dependencies, including their real paths in Metro's watch folders. The `--fixtures` snapshot alone uses a separate `com.milkmarket.mobile.local` app identifier, routes relay sockets to localhost while preserving Metro connections, and asks for OS notification permission to allow simulator injection. It does not enable simulator push-token registration. The normal app entry never imports the fixture file. Omit `--fixtures` for a normal source build.

```sh
cd "$NATIVE_WORKSPACE/apps/mobile/ios"
pod install
cd /absolute/path/to/repository
node scripts/mobile/fix-generated-ios.mjs "$NATIVE_WORKSPACE/apps/mobile/ios"
xcodebuild -workspace "$NATIVE_WORKSPACE/apps/mobile/ios/MilkMarketVendor.xcworkspace" \
  -scheme MilkMarketVendor -configuration Debug -sdk iphonesimulator \
  -destination 'id=YOUR_SIMULATOR_UDID' -derivedDataPath /tmp/milk-mobile-xcode -jobs 4 build
xcrun simctl install YOUR_SIMULATOR_UDID /tmp/milk-mobile-xcode/Build/Products/Debug-iphonesimulator/MilkMarketVendor.app
cd "$NATIVE_WORKSPACE/apps/mobile"
NODE_OPTIONS=--dns-result-order=ipv4first EXPO_PUBLIC_API_BASE_URL=http://127.0.0.1:5000 pnpm exec expo start --dev-client --localhost
```

The generated-script correction quotes Expo commands when linked dependency paths contain spaces. It changes only generated Xcode projects. Build from the same snapshot that Metro serves; regenerate the snapshot after source changes. Launch the installed local app and connect its development client to loopback Metro.

For Android, prepare with `android --fixtures`, run `adb reverse tcp:5000 tcp:5000`, `adb reverse tcp:5011 tcp:5011` and `adb reverse tcp:8081 tcp:8081`, then build/install the generated `android` project with Gradle. The same loopback API/relay addresses then work. An Expo Android export verifies JavaScript packaging only, not the native build or UI.

## Native checks to record

1. Sign in using the synthetic nsec from `fixture.json`. Confirm storefront, listings and Orders load from Docker. Verify current dashboard copy and notification controls. Simulator registration displays its availability limitation without blocking seller work.
2. Refresh Orders, open the synthetic order, restart the app, and verify its validated data restores. Exercise the existing shipping quote/label flow with the local provider. The fixture label URL is deliberately non-resolving; no external document is downloaded.
3. Background the app. Inject `activity.apns` with `xcrun simctl push YOUR_SIMULATOR_UDID com.milkmarket.mobile.local "$MILK_MOBILE_FIXTURE_DIR/activity.apns"`. Its `body` object matches Expo's iOS remote-data envelope. Tap the resulting alert and verify it opens the validated matching order with an Orders back button. Repeat after terminating the app. Test malformed payloads and a different seller key; they must not open another seller's details.
4. Sign out, inject an alert, and verify sign-in is required. Sign in with the wrong synthetic account and verify no order details are revealed. Sign out again and confirm private order data is gone.
5. Interrupt the local API while foregrounding the app. Verify refresh errors leave existing seller workflows usable, then reconnect and retry. Check that pending buyer-notification outbox work resumes without duplicate status persistence or label purchases.
6. On signed staging builds and physical iOS/Android devices, separately verify permission denial, opt-in, push-delivered registration challenge, foreground suppression, background/cold-start notification opening, token renewal and offline logout revocation. Record actual provider receipts and device results. Do not substitute simulator injection for this gate.

Run final `pnpm typecheck`, `pnpm lint`, `pnpm test:mobile`, `pnpm test -- --runInBand`, `pnpm test:db`, and `pnpm build:web`. Keep logs and screenshots outside the repository. Keep the external phase plan/spec outside the branch, and use one-line commit messages. Do not push before the required local native and Docker checks pass.

## Return-label addition

After the fixture seller has shipped the order, run `node scripts/mobile/verify-return-label.cjs` for signed HTTP rejection checks. In the native order detail, review Return shipping and the buyer-to-seller addresses. Set `shipping-controls.json` in the fixture directory to `{"failReturnRates":true}` to exercise a purchase failure before a transaction is sent; restore `{}` and retry explicitly. Confirm a return label appears with its own tracking, and Shipping history distinguishes outbound/return labels. Run `node scripts/mobile/verify-return-label.cjs --after-purchase` to verify one persisted return purchase, duplicate rejection and unchanged shipped status. The fixture provider never buys a real label. Return-request message handling and refunds/exchanges are outside this addition.
