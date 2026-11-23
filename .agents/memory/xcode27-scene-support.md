---
name: Xcode 27 scene lifecycle prerequisite
description: Why moving iOS builds to Xcode 27 is not just an EAS image change.
---

Do not move an older Expo app to an Xcode 27 EAS image without migrating to the UIKit scene lifecycle.

**Why:** Expo's infrastructure documentation warns that apps built with Xcode 27 launch on iOS 27 only with scene lifecycle support. Its supported `expo-build-properties` migration requires Expo SDK 57.0.23 or newer and the standard SDK 57 Swift AppDelegate. SDK 58 includes scene support. Merely adding the property to an older SDK is not a supported migration.

**How to apply:** Recheck the current Expo documentation before choosing the migration path. Plan dependency/native compatibility verification as part of the toolchain upgrade, then pin a named EAS image rather than `latest`. Keep the existing signing and pre-submission entitlement checks intact. Do not equate a config edit with a validated build or successful App Store Connect upload.

Sources:
- https://docs.expo.dev/build-reference/infrastructure/
- https://docs.expo.dev/versions/v57.0.0/sdk/build-properties/

Expo Router 57 bundles its own navigation contexts. Do not combine its providers with runtime hooks or theme providers from the separate React Navigation packages; use Router's exports or its navigation compatibility entry point consistently.

**Why:** the separate package has different context identities. Typechecking and bundle export pass, but listing and payment hooks then fail at runtime with a missing-navigation-object error.

**How to apply:** check every runtime navigation import during the migration, including shared payment hooks and theme setup. Verify actual hooks mounted beneath Router's real context providers, not only mocked-hook screen tests. Query parsing checks must exercise Router's bundled implementation too.
