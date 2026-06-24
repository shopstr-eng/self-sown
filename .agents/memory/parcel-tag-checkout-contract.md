---
name: Parcel tag is a checkout contract
description: The NIP-99 parcel tag is byte-stable contract read by checkout for live rates; all product-republish paths must share one builder and preserve listing identity.
---

The `["parcel", weight, length?, width?, height?]` tag on a kind:30402 listing is
read back by `parseTags` + checkout to request live USPS rates. Its exact shape is
a **contract**, not a display string.

**Rule:**

- There is ONE writer of this tag: `buildParcelTag()` in `utils/nostr/nostr-helper-functions.ts`.
  Never re-inline the tag-building logic anywhere (the product editor used to, and
  it drifts). Weight must be positive (else no tag); only positive dims are written;
  trailing empty dims are trimmed but interior blanks stay in slot (so a length+height
  parcel keeps height in the 4th slot).
- Any path that rewrites a listing (the editor, the Settings→Shipping "apply parcel
  template to listings" bulk flow via `republishProductWithParcel`, future bulk edits)
  must REPUBLISH the same replaceable event: keep the `d` tag and `ship_from_zip`,
  drop only `parcel` + `published_at`, then re-add. Dropping the `d` tag forks the
  listing instead of updating it.

**Why:** A divergent parcel tag silently breaks live-rate calculation at checkout
(buyers see fallback/static shipping, not real USPS rates) — the exact bug class the
apply-template feature exists to fix. The drift is invisible until a buyer checks out,
so a `buildParcelTag` unit test (`__tests__/utils/build-parcel-tag.test.ts`) guards the
byte output.

**How to apply:** When adding any feature that sets/changes a listing's package size,
call `buildParcelTag` + `republishProductWithParcel` rather than constructing tags by
hand. When updating the modal/list of "my listings", remember kind:30402 republish
gives the event a NEW id, so update ProductContext via
`removeDeletedProductEvent(oldId)` + `addNewlyCreatedProductEvent(signed)`.
