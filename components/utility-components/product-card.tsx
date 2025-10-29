import React, { useContext } from "react";
import { Chip } from "@nextui-org/react";
import Link from "next/link";
import { locationAvatar } from "./dropdowns/location-dropdown";
import ImageCarousel from "./image-carousel";
import CompactPriceDisplay from "./display-monetary-info";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import { ProfileWithDropdown } from "./profile/profile-dropdown";
import { useRouter } from "next/router";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";

export default function ProductCard({
  productData,
  onProductClick,
  href,
}: {
  productData: ProductData;
  onProductClick?: (productId: ProductData, e?: React.MouseEvent) => void;
  href?: string | null;
}) {
  const router = useRouter();
  const { pubkey: userPubkey } = useContext(SignerContext);
  if (!productData) return null;

  const content = (
    <div
      onClick={() => {
        onProductClick && onProductClick(productData);
      }}
      className="flex h-full flex-col"
    >
      {/* Image Section with Title Overlay */}
      <div className="relative h-64 w-full overflow-hidden border-b-4 border-black bg-gray-200">
        <ImageCarousel
          images={productData.images}
          classname="w-full h-full object-cover"
          showThumbs={false}
        />
        {/* Title Overlay at Bottom of Image */}
        <div className="absolute bottom-0 left-0 right-0 border-t-2 border-black bg-white/95 p-3 backdrop-blur-sm">
          <h2 className="truncate text-2xl font-bold text-black">
            {productData.title}
          </h2>
        </div>
      </div>

      {/* Card Content */}
      <div className="flex min-h-0 flex-1 flex-col space-y-3 bg-white p-4">
        {/* Profile Section */}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <div className="min-w-0 flex-1 overflow-hidden">
            <ProfileWithDropdown
              pubkey={productData.pubkey}
              dropDownKeys={
                productData.pubkey === userPubkey
                  ? ["shop_profile"]
                  : ["shop", "inquiry", "copy_npub"]
              }
              bg="light"
            />
          </div>
          {/* Status Badge */}
          {productData.status === "active" && (
            <Chip className="flex-shrink-0 border-2 border-black bg-green-500 text-xs font-bold text-white">
              Active
            </Chip>
          )}
          {productData.status === "sold" && (
            <Chip className="flex-shrink-0 border-2 border-black bg-red-500 text-xs font-bold text-white">
              Sold
            </Chip>
          )}
          {productData.status === "soon" && (
            <Chip className="flex-shrink-0 border-2 border-black bg-yellow-500 text-xs font-bold text-black">
              Soon
            </Chip>
          )}
        </div>

        {/* Location and Price - with proper spacing */}
        {router.pathname !== "/" && (
          <div className="mt-auto flex min-w-0 items-center justify-between gap-3 pt-2">
            <div className="min-w-0 max-w-[60%] flex-shrink-0">
              <Chip
                startContent={locationAvatar(productData.location)}
                className="max-w-full truncate border-2 border-black bg-primary-blue text-xs font-semibold text-white"
              >
                <span className="truncate">{productData.location}</span>
              </Chip>
            </div>
            <div className="min-w-0 flex-shrink-0">
              <CompactPriceDisplay monetaryInfo={productData} />
            </div>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div
      // Updated shadow to use shadow-neo and a larger hover shadow.
      // Note: Your original shadow was 8px. shadow-neo is 4px. I've kept the 8px for hover.
      className="flex w-full max-w-sm cursor-pointer flex-col overflow-hidden rounded-md border-4 border-black bg-white shadow-neo duration-200 transition-transform hover:-translate-y-1 hover:shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] active:translate-y-0 active:shadow-neo"
    >
      {href ? (
        <Link href={href} className="block flex h-full flex-col">
          {content}
        </Link>
      ) : (
        content
      )}
    </div>
  );
}
