import React from "react";
import { Card, CardHeader, CardBody, Image } from "@heroui/react";
import { Community } from "@/utils/types/types";
import { nip19 } from "nostr-tools";
import { sanitizeUrl } from "@braintree/sanitize-url";
import { BLUEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import Link from "next/link";

interface CommunityCardProps {
  community: Community;
}

const CommunityCard: React.FC<CommunityCardProps> = ({ community }) => {
  const naddr = nip19.naddrEncode({
    identifier: community.d,
    pubkey: community.pubkey,
    kind: 34550,
  });

  return (
    <Card className="shadow-neo w-full max-w-sm rounded-lg border-4 border-black bg-white transition-transform hover:-translate-y-1">
      <CardHeader className="flex-col items-start px-6 pt-4 pb-0">
        <p className="text-xs font-bold tracking-wide text-gray-600 uppercase">
          Community
        </p>
        <h4 className="mt-1 text-xl font-bold text-black">{community.name}</h4>
      </CardHeader>
      <CardBody className="px-6 py-4">
        <div className="mb-4 overflow-hidden rounded-md border-2 border-black">
          <Image
            alt={community.name}
            className="h-[180px] w-full object-cover"
            src={sanitizeUrl(community.image)}
            width="100%"
            radius="none"
          />
        </div>
        <p className="mb-4 line-clamp-2 text-sm text-gray-700">
          {community.description}
        </p>
        <Link
          href={`/communities/${naddr}`}
          className={`${BLUEBUTTONCLASSNAMES} block w-full text-center`}
        >
          Visit
        </Link>
      </CardBody>
    </Card>
  );
};

export default CommunityCard;
