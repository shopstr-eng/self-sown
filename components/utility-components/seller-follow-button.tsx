import { useContext, useState } from "react";
import { Button } from "@heroui/react";
import { NostrContext, SignerContext } from "./nostr-context-provider";
import { FollowsContext } from "@/utils/context/context";
import { getLocalStorageData } from "@/utils/nostr/nostr-helper-functions";
import {
  buildContactListUpdate,
  contactPubkeys,
  latestContactList,
} from "@/utils/nostr/contact-list";
import SignInModal from "../sign-in/SignInModal";
import type { NostrEvent } from "@/utils/types/types";

export default function SellerFollowButton({
  sellerPubkey,
}: {
  sellerPubkey: string;
}) {
  const { nostr } = useContext(NostrContext);
  const { signer, pubkey: userPubkey, isLoggedIn } = useContext(SignerContext);
  const follows = useContext(FollowsContext);
  const [isOpen, setIsOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  if (!sellerPubkey || sellerPubkey === userPubkey) return null;

  const isFollowing = (follows.directFollowList ?? []).includes(sellerPubkey);

  const toggleFollow = async () => {
    if (!isLoggedIn || !signer || !nostr || !userPubkey) {
      setIsOpen(true);
      return;
    }

    setIsSaving(true);
    try {
      const { relays, readRelays, writeRelays } = getLocalStorageData();
      const relayUrls = Array.from(
        new Set([...writeRelays, ...relays, ...readRelays])
      );
      const events = (await nostr.fetch(
        [{ kinds: [3], authors: [userPubkey] }],
        {},
        relayUrls
      )) as NostrEvent[];
      const current = latestContactList(events);
      const shouldFollow = !contactPubkeys(current?.tags ?? []).includes(
        sellerPubkey
      );
      const signed = await signer.sign(
        buildContactListUpdate(
          current?.tags ?? [],
          sellerPubkey,
          shouldFollow,
          current?.created_at
        )
      );
      await nostr.publish(signed, relayUrls);
      follows.setDirectFollowList?.(contactPubkeys(signed.tags));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        isLoading={isSaving}
        aria-label={isFollowing ? "Unfollow seller" : "Follow seller"}
        className={
          isFollowing
            ? "shadow-neo border-2 border-black bg-white font-bold text-black"
            : "bg-primary-yellow shadow-neo border-2 border-black font-bold text-black"
        }
        onPress={toggleFollow}
      >
        {isFollowing ? "Following" : "Follow Seller"}
      </Button>
      <SignInModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}
