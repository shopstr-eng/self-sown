import type {
  SellerListingDraft,
  SellerListingOptionsDraft,
  NostrEventRecord,
} from "@milk-market/domain";

export function changeListingBundleMode(
  value: SellerListingOptionsDraft,
  bundleMode: SellerListingOptionsDraft["bundleMode"]
): SellerListingOptionsDraft {
  return value.bundleMode === bundleMode
    ? value
    : { ...value, bundleMode, bundles: [] };
}
export function removeListingOption(
  value: SellerListingOptionsDraft,
  group: "sizes" | "volumes" | "weights" | "choices",
  label: string
): SellerListingOptionsDraft {
  const next = {
    ...value,
    [group]: value[group].filter((row) => row.label !== label),
  };
  if (group === "volumes" || group === "weights") {
    const labels = [...next.volumes, ...next.weights].map((row) => row.label);
    next.bundles = next.bundles.filter(
      (tier) => !tier.optionLabel || labels.includes(tier.optionLabel)
    );
  }
  return next;
}
export function listingHasUnsavedChanges(
  draft: SellerListingDraft | null,
  initial: SellerListingDraft | null
): boolean {
  if (!draft || !initial) return false;
  const content = (value: SellerListingDraft) => {
    const {
      pendingEventId: _pending,
      eventId: _event,
      dTag: _d,
      sourceCreatedAt: _at,
      sourcePubkey: _owner,
      sourceTags: _tags,
      ...fields
    } = value;
    return fields;
  };
  return JSON.stringify(content(draft)) !== JSON.stringify(content(initial));
}
export function assertSellerListingEditable(
  pubkey: string,
  draft: SellerListingDraft,
  events: NostrEventRecord[]
): void {
  if (draft.sourcePubkey && draft.sourcePubkey !== pubkey)
    throw new Error("This product belongs to another seller.");
  if (!draft.eventId) return;
  const source = events.find(
    (event) =>
      event.id === draft.eventId &&
      event.pubkey === pubkey &&
      event.kind === 30402
  );
  if (!source)
    throw new Error(
      "This product is no longer available. Reload your catalog."
    );
  if (
    events.some(
      (event) =>
        event.kind === 30402 &&
        event.pubkey === pubkey &&
        event.tags.some((tag) => tag[0] === "d" && tag[1] === draft.dTag) &&
        event.id !== draft.eventId &&
        event.id !== draft.pendingEventId &&
        Number(event.created_at) >= Number(source.created_at)
    )
  )
    throw new Error(
      "This product changed on another device. Reload it before saving."
    );
}
