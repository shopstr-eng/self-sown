import React from "react";
import { Card, CardHeader, CardBody, Image, Button } from "@nextui-org/react";
import { Community } from "@/utils/types/types";
import { useRouter } from "next/router";
import { nip19 } from "nostr-tools";
import { sanitizeUrl } from "@braintree/sanitize-url";
import { BLACKBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

interface CommunityCardProps {
  community: Community;
}

const CommunityCard: React.FC<CommunityCardProps> = ({ community }) => {
  const router = useRouter();

  const handleVisit = () => {
    const naddr = nip19.naddrEncode({
      identifier: community.d,
      pubkey: community.pubkey,
      kind: 34550,
    });
    router.push(`/communities/${naddr}`);
  };

  return (
    <Card className="w-64 rounded-2xl border-2 border-black bg-white py-4 shadow-md">
      <CardHeader className="flex-col items-start px-4 pb-0 pt-2">
        <p className="text-tiny font-bold uppercase text-light-text">
          Community
        </p>
        <h4 className="text-large font-bold text-light-text">
          {community.name}
        </h4>
      </CardHeader>
      <CardBody className="overflow-visible py-2">
        <Image
          alt={community.name}
          className="h-[140px] w-full rounded-xl object-cover"
          src={sanitizeUrl(community.image)}
          width={270}
        />
        <p className="mt-2 line-clamp-2 text-sm text-default-500 text-light-text">
          {community.description}
        </p>
        <Button
          onClick={handleVisit}
          className={`${BLACKBUTTONCLASSNAMES} mt-4 w-full`}
        >
          Visit
        </Button>
      </CardBody>
    </Card>
  );
};

export default CommunityCard;
