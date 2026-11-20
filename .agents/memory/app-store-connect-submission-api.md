# App Store Connect API — submission field gotchas

Driving an App Store submission through the ASC public API (ES256 key). Several fields are not where you would guess, and a few cannot be set by the public API at all.

## Auth / JWT

- ES256 signature MUST be ieee-p1363 encoded, not the default DER: `crypto.sign('sha256', data, { key: createPrivateKey(pem), dsaEncoding: 'ieee-p1363' })`. DER encoding returns 401 NOT_AUTHORIZED with no useful detail.

## Enumeration without burning the submission limit

- `POST /v1/reviewSubmissions` then `POST /v1/reviewSubmissionItems` and read `errors[0].meta.associatedErrors` — it enumerates every missing field with its JSON pointer, the fastest authoritative checklist.
- **`reviewSubmissions` cannot be DELETEd (403 FORBIDDEN_ERROR) and an empty `READY_FOR_REVIEW` submission is NOT cancellable.** Creating a fresh submission per run therefore leaks empty drafts until the per-app concurrency limit (5) is hit, after which `CONCURRENT_REVIEW_SUBMISSION_LIMIT_EXCEEDED` blocks every new submission permanently. Instead, GET `/v1/apps/{id}/reviewSubmissions`, reuse an unsubmitted `READY_FOR_REVIEW` one, and add items to it. `reviewSubmissionItems` CAN be deleted (bogus id → 404, not 403).
- Submitting = stage the version item on that draft submission, then `PATCH /v1/reviewSubmissions/{id}` with `attributes.submitted: true`. A version with open blockers makes the item POST 409 (nothing is staged).

## Field locations that surprise

- `contentRightsDeclaration` is an attribute of the **app** (`PATCH /v1/apps/{id}`), not appInfo.
- `primaryCategory` is an appInfo relationship set via `PATCH /v1/appInfos/{id}` with `relationships.primaryCategory`; a `PATCH .../relationships/primaryCategory` returns 403.
- `ageRatingDeclaration` id == **appInfo** id (fetch `/v1/appInfos/{id}/ageRatingDeclaration`), NOT the version id. Its attributes mix types: booleans (advertising, gambling, messagingAndChat, datingAndRelationships, socialMedia, userGeneratedContent, parentalControls, unrestrictedWebAccess, lootBox, ageAssurance, sharedLocation, healthOrWellnessTopics, socialMediaAgeRestricted) vs enum strings `NONE|INFREQUENT_OR_MILD|FREQUENT_OR_INTENSE` (contests, alcoholTobaccoOrDrugUseOrReferences, gamblingSimulated, gunsOrOtherWeapons, medicalOrTreatmentInformation, profanityOrCrudeHumor, sexualContent*/violence*/horrorOrFearThemes/matureOrSuggestiveThemes).
- Review info: `POST /v1/appStoreReviewDetails` with relationship `appStoreVersion` (one per version). `demoAccountName` and `demoAccountPassword` are BOTH required when `demoAccountRequired: true`. `contactPhone` must be `+` country code or it 409s.
- Pricing (free app): `POST /v1/appPriceSchedules` with `included` appPrices. Inline-created ids MUST use the literal local-id form `${local-id}`, else ENTITY_ERROR.INCLUDED.INVALID_ID. `appPriceSchedules` allows only CREATE and GET_INSTANCE (no UPDATE/DELETE) — an existing schedule's price cannot be changed through the public API; only create a schedule when the app has none. A price schedule entry is only evidence of the price it applies now/next; check base territory + each manual price's start/end dates (skip expired), not the mere presence of a zero-priced entry.
- Availability: `POST /v2/appAvailabilities` (v1 404s) and it requires a `territoryAvailabilities` relationship.

## Public API vs web UI

- **App Privacy / data usages (`appDataUsages`)**: no public API path exists (all 404). Apple exposes only a private `PATCH /iris/v1/appDataUsages/{usageID}` contract usable from a web session. Treat App Privacy as an App Store Connect web-UI step.
- **Screenshots ARE API-uploadable** (`POST /v1/appScreenshotSets` then `POST /v1/appScreenshots` with asset upload operations). The API can upload them; the binding constraint is producing suitable image assets, which requires the app running on a device or simulator. Required sets follow the build's device families — with `supportsTablet: true` a build needs an iPad set as well as an iPhone set. Do not conflate "we cannot capture assets here" with "the API cannot upload".

**Why:** a Tap to Pay review package alone was insufficient because the app had never been submitted and first submission requires the whole listing.

**How to apply:** start any ASC submission work by enumerating missing fields via the reviewSubmission item error, then separate what the API can set (most listing fields, screenshots once you have assets) from what needs the web UI (App Privacy).
