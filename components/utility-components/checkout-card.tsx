/* eslint-disable @next/next/no-img-element */

import React, { useContext, useEffect, useState } from "react";
import { nip19 } from "nostr-tools";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import { ProfileWithDropdown } from "./profile/profile-dropdown";
import { DisplayCheckoutCost } from "./display-monetary-info";
import ProductInvoiceCard from "../product-invoice-card";
import { useRouter } from "next/router";
import { Button, Chip, useDisclosure } from "@nextui-org/react";
import { locationAvatar } from "./dropdowns/location-dropdown";
import { FaceFrownIcon, FaceSmileIcon } from "@heroicons/react/24/outline";
import { ReviewsContext } from "@/utils/context/context";
import FailureModal from "../utility-components/failure-modal";
import SuccessModal from "../utility-components/success-modal";
import SignInModal from "../sign-in/SignInModal";
import currencySelection from "../../public/currencySelection.json";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import VolumeSelector from "./volume-selector";
import WeightSelector from "./weight-selector";

const SUMMARY_CHARACTER_LIMIT = 200;

export default function CheckoutCard({
  productData,
  setFiatOrderIsPlaced,
  setFiatOrderFailed,
  setInvoiceIsPaid,
  setInvoiceGenerationFailed,
  setCashuPaymentSent,
  setCashuPaymentFailed,
}: {
  productData: ProductData;
  setFiatOrderIsPlaced: (fiatOrderIsPlaced: boolean) => void;
  setFiatOrderFailed: (fiatOrderFailed: boolean) => void;
  setInvoiceIsPaid: (invoiceIsPaid: boolean) => void;
  setInvoiceGenerationFailed: (invoiceGenerationFailed: boolean) => void;
  setCashuPaymentSent: (cashuPaymentSent: boolean) => void;
  setCashuPaymentFailed: (cashuPaymentFailed: boolean) => void;
}) {
  const { pubkey: userPubkey, isLoggedIn } = useContext(SignerContext);
  const { isOpen, onOpen, onClose } = useDisclosure();

  const router = useRouter();

  const [isExpanded, setIsExpanded] = useState(false);
  const [isBeingPaid, setIsBeingPaid] = useState(false);
  const [selectedImage, setSelectedImage] = useState(productData.images[0]);
  const [selectedImageIndex, setSelectedImageIndex] = useState(0);
  const [selectedSize, setSelectedSize] = useState<string | undefined>(
    undefined
  );
  const [hasSizes, setHasSizes] = useState(false);
  const [isAdded, setIsAdded] = useState(false);

  const [merchantReview, setMerchantReview] = useState(0);
  const [productReviews, setProductReviews] =
    useState<Map<string, string[][]>>();
  const [isFetchingReviews, setIsFetchingReviews] = useState(false);

  const [merchantQuality, setMerchantQuality] = useState("");

  const [showFailureModal, setShowFailureModal] = useState(false);
  const [failureText, setFailureText] = useState("");
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const [cart, setCart] = useState<ProductData[]>([]);
  const [selectedVolume, setSelectedVolume] = useState<string>("");
  const [selectedWeight, setSelectedWeight] = useState<string>("");
  const [currentPrice, setCurrentPrice] = useState(productData.price);

  const reviewsContext = useContext(ReviewsContext);

  const hasVolumes = productData.volumes && productData.volumes.length > 0;
  const hasWeights = productData.weights && productData.weights.length > 0;

  useEffect(() => {
    if (selectedVolume && productData.volumePrices) {
      const volumePrice = productData.volumePrices.get(selectedVolume);
      if (volumePrice !== undefined) {
        setCurrentPrice(volumePrice);
      }
    } else if (selectedWeight && productData.weightPrices) {
      const weightPrice = productData.weightPrices.get(selectedWeight);
      if (weightPrice !== undefined) {
        setCurrentPrice(weightPrice);
      }
    } else {
      setCurrentPrice(productData.price);
    }
  }, [
    selectedVolume,
    productData.price,
    productData.volumePrices,
    selectedWeight,
    productData.weightPrices,
  ]);

  const toggleExpand = () => {
    setIsExpanded(!isExpanded);
  };

  const renderSummary = () => {
    if (productData.summary.length <= SUMMARY_CHARACTER_LIMIT || isExpanded) {
      return productData.summary;
    }
    return `${productData.summary.slice(0, SUMMARY_CHARACTER_LIMIT)}...`;
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      const cartList = localStorage.getItem("cart")
        ? JSON.parse(localStorage.getItem("cart") as string)
        : [];
      if (cartList && cartList.length > 0) {
        setCart(cartList);
      }
    }
  }, []);

  useEffect(() => {
    const productExists = cart.some(
      (item: ProductData) => item.id === productData.id
    );
    if (productExists) {
      setIsAdded(true);
    }
  }, [cart, productData.id]);

  useEffect(() => {
    setIsFetchingReviews(true);
    if (
      productData.pubkey &&
      reviewsContext.merchantReviewsData.has(productData.pubkey) &&
      typeof reviewsContext.merchantReviewsData.get(productData.pubkey) !=
        "undefined" &&
      reviewsContext.productReviewsData.has(productData.pubkey) &&
      typeof reviewsContext.productReviewsData.get(productData.pubkey) !=
        "undefined"
    ) {
      const merchantScoresMap = reviewsContext.merchantReviewsData;
      const productReviewScore = reviewsContext.productReviewsData.get(
        productData.pubkey
      );
      if (merchantScoresMap && productReviewScore) {
        for (const [productPubkey, scores] of merchantScoresMap.entries()) {
          if (productPubkey === productData.pubkey) {
            const averageScore =
              scores.reduce((a, b) => a + b, 0) / scores.length;
            setMerchantReview(averageScore);
          }
        }
        const productReviewValue = productData.d
          ? productReviewScore.get(productData.d)
          : undefined;
        setProductReviews(
          productReviewValue !== undefined
            ? productReviewValue
            : new Map<string, string[][]>()
        );
      }
    }
    setIsFetchingReviews(false);
  }, [productData.pubkey, reviewsContext, productData.d]);

  useEffect(() => {
    setHasSizes(
      !!(
        productData.sizes &&
        productData.sizes.length > 0 &&
        productData.sizes.some(
          (size) => (productData.sizeQuantities?.get(size) || 0) > 0
        )
      )
    );
  }, [productData.sizes, productData.sizeQuantities]);

  useEffect(() => {
    if (!reviewsContext.merchantReviewsData.has(productData.pubkey)) {
      setMerchantQuality("");
    } else if (merchantReview >= 0.75) {
      setMerchantQuality("Trustworthy");
    } else if (merchantReview >= 0.5) {
      setMerchantQuality("Solid");
    } else if (merchantReview >= 0.25) {
      setMerchantQuality("Questionable");
    } else {
      setMerchantQuality("Don't trust, don't bother verifying");
    }
  }, [reviewsContext, merchantReview, productData.pubkey]);

  const toggleBuyNow = () => {
    if (isLoggedIn) {
      setIsBeingPaid(!isBeingPaid);
    } else {
      onOpen();
    }
  };

  const handleAddToCart = () => {
    if (isLoggedIn) {
      if (
        !currencySelection.hasOwnProperty(productData.currency.toUpperCase()) ||
        productData.totalCost < 1
      ) {
        setFailureText(
          "The price and/or currency set for this listing was invalid."
        );
        setShowFailureModal(true);
        return;
      }
      let updatedCart = [];
      const productToAdd = { ...productData };

      if (selectedSize) {
        productToAdd.selectedSize = selectedSize;
      }
      if (selectedVolume) {
        productToAdd.selectedVolume = selectedVolume;
        if (productData.volumePrices) {
          const volumePrice = productData.volumePrices.get(selectedVolume);
          if (volumePrice !== undefined) {
            productToAdd.volumePrice = volumePrice;
          }
        }
      }
      if (selectedWeight) {
        productToAdd.selectedWeight = selectedWeight;
        if (productData.weightPrices) {
          const weightPrice = productData.weightPrices.get(selectedWeight);
          if (weightPrice !== undefined) {
            productToAdd.weightPrice = weightPrice;
          }
        }
      }

      updatedCart = [...cart, productToAdd];
      setCart(updatedCart);
      localStorage.setItem("cart", JSON.stringify(updatedCart));
    } else {
      onOpen();
    }
  };

  const handleShare = async () => {
    const naddr = nip19.naddrEncode({
      identifier: productData.d as string,
      pubkey: productData.pubkey,
      kind: 30402,
    });
    const shareData = {
      title: productData.title,
      url: `${window.location.origin}/listing/${naddr}`,
    };
    if (navigator.share) {
      await navigator.share(shareData);
    } else {
      navigator.clipboard.writeText(
        `${window.location.origin}/listing/${naddr}`
      );
      setShowSuccessModal(true);
    }
  };

  const handleSendMessage = (pubkeyToOpenChatWith: string) => {
    if (isLoggedIn) {
      router.push({
        pathname: "/orders",
        query: { pk: nip19.npubEncode(pubkeyToOpenChatWith), isInquiry: true },
      });
    } else {
      onOpen();
    }
  };

  const renderSizeGrid = () => {
    return (
      <div className="mb-4">
        <p className="mb-2 text-sm font-semibold text-black">Select Size:</p>
        <div className="grid grid-cols-3 gap-2">
          {productData.sizes?.map((size) =>
            (productData.sizeQuantities?.get(size) || 0) > 0 ? (
              <button
                key={size}
                className={`rounded-md border-2 border-black p-2 text-sm font-bold shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                  selectedSize === size
                    ? "bg-primary-yellow text-black"
                    : "bg-white text-black"
                }`}
                onClick={() => setSelectedSize(size)}
              >
                {size}
              </button>
            ) : null
          )}
        </div>
      </div>
    );
  };

  const handleImageSelect = (image: string, index: number) => {
    setSelectedImage(image);
    setSelectedImageIndex(index);
  };

  // Create updated product data with selected volume or weight price
  const updatedProductData = {
    ...productData,
    price: currentPrice,
    totalCost: currentPrice + (productData.shippingCost ?? 0),
  };

  return (
    <div className="flex w-full items-center justify-center bg-white p-4">
      <div className="flex w-full max-w-7xl flex-col">
        {!isBeingPaid ? (
          <>
            <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
              {/* LEFT COLUMN - Image Gallery */}
              <div className="flex flex-col gap-4">
                {/* Main Image */}
                <div className="rounded-md border-2 border-black bg-white p-4 shadow-neo">
                  <img
                    src={selectedImage}
                    alt="Selected product image"
                    className="w-full rounded-md object-cover"
                    style={{ aspectRatio: "1 / 1" }}
                  />
                </div>

                {/* Thumbnail Tabs */}
                {productData.images.length > 1 && (
                  <div className="flex gap-2 overflow-x-auto pb-2">
                    {productData.images.map((image, index) => (
                      <button
                        key={index}
                        onClick={() => handleImageSelect(image, index)}
                        className={`flex-shrink-0 rounded-md border-2 border-black bg-white px-4 py-2 font-bold shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                          selectedImageIndex === index
                            ? "bg-primary-yellow"
                            : "bg-white"
                        }`}
                      >
                        View {index + 1}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* RIGHT COLUMN - Product Details */}
              <div className="flex flex-col gap-4">
                {/* Profile & Merchant Quality */}
                <div className="flex flex-wrap items-center gap-3">
                  <ProfileWithDropdown
                    pubkey={productData.pubkey}
                    dropDownKeys={
                      productData.pubkey === userPubkey
                        ? ["shop_profile"]
                        : ["shop", "inquiry", "copy_npub"]
                    }
                  />
                  {merchantQuality !== "" && (
                    <div className="inline-flex items-center gap-2 rounded-md border-2 border-black bg-white px-3 py-1 shadow-neo">
                      {merchantReview >= 0.5 ? (
                        <>
                          <FaceSmileIcon
                            className={`h-6 w-6 ${
                              merchantReview >= 0.75
                                ? "text-green-500"
                                : "text-green-300"
                            }`}
                          />
                          <span className="text-sm font-semibold text-black">
                            {merchantQuality}
                          </span>
                        </>
                      ) : (
                        <>
                          <FaceFrownIcon
                            className={`h-6 w-6 ${
                              merchantReview >= 0.25
                                ? "text-red-300"
                                : "text-red-500"
                            }`}
                          />
                          <span className="text-sm font-semibold text-black">
                            {merchantQuality}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>

                {/* Product Title */}
                <h1 className="text-3xl font-bold text-black">
                  {productData.title}
                </h1>

                {/* Availability Info */}
                {productData.location && (
                  <p className="text-sm text-red-600">
                    Available for {productData.location} state orders since
                    delivery available for King County residents
                  </p>
                )}

                {/* Description */}
                <div>
                  <p className="text-base text-black">{renderSummary()}</p>
                  {productData.summary.length > SUMMARY_CHARACTER_LIMIT && (
                    <button
                      onClick={toggleExpand}
                      className="mt-2 text-sm font-bold text-black underline hover:text-primary-blue"
                    >
                      {isExpanded ? "show less" : "show more"}
                    </button>
                  )}
                </div>

                {/* Condition */}
                {productData.condition && (
                  <p className="text-sm text-black">
                    <span className="font-semibold">Condition:</span>{" "}
                    {productData.condition}
                  </p>
                )}

                {/* Restrictions */}
                {productData.restrictions && (
                  <p className="text-sm text-black">
                    <span className="font-semibold">Restrictions:</span>{" "}
                    <span className="text-red-600">
                      {productData.restrictions}
                    </span>
                  </p>
                )}

                {/* Volume Selector */}
                {hasVolumes && (
                  <VolumeSelector
                    volumes={productData.volumes!}
                    volumePrices={productData.volumePrices!}
                    currency={productData.currency}
                    selectedVolume={selectedVolume}
                    onVolumeChange={setSelectedVolume}
                    isRequired={true}
                  />
                )}

                {/* Weight Selector */}
                {hasWeights && (
                  <WeightSelector
                    weights={productData.weights!}
                    weightPrices={productData.weightPrices!}
                    currency={productData.currency}
                    selectedWeight={selectedWeight}
                    onWeightChange={setSelectedWeight}
                    isRequired={true}
                  />
                )}

                {/* Size Grid */}
                {hasSizes && renderSizeGrid()}

                {/* Price Display */}
                <div className="mt-2">
                  <DisplayCheckoutCost monetaryInfo={updatedProductData} />
                </div>

                {/* Location Chip */}
                <div className="flex items-center gap-2">
                  <Chip
                    startContent={locationAvatar(productData.location)}
                    className="rounded-full border-2 border-black bg-white px-3 py-1 font-bold shadow-neo"
                  >
                    <span className="text-black">
                      📍 {productData.location}
                    </span>
                  </Chip>
                </div>

                {/* Action Buttons */}
                <div className="flex flex-wrap gap-3">
                  {productData.status !== "sold" ? (
                    <>
                      {/* Buy Now - Solid Yellow */}
                      <Button
                        className={`rounded-md border-2 border-black bg-primary-yellow px-6 py-2 font-bold text-black shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                          (hasSizes && !selectedSize) ||
                          (hasVolumes && !selectedVolume) ||
                          (hasWeights && !selectedWeight)
                            ? "cursor-not-allowed opacity-50"
                            : ""
                        }`}
                        onClick={toggleBuyNow}
                        disabled={
                          (hasSizes && !selectedSize) ||
                          (hasVolumes && !selectedVolume) ||
                          (hasWeights && !selectedWeight)
                        }
                        size="lg"
                      >
                        Buy Now
                      </Button>

                      {/* Add To Cart - Light Blue */}
                      <Button
                        className={`rounded-md border-2 border-black bg-blue-100 px-6 py-2 font-bold text-black shadow-neo transition-transform hover:-translate-y-0.5 hover:bg-blue-200 active:translate-y-0.5 ${
                          isAdded ||
                          (hasSizes && !selectedSize) ||
                          (hasVolumes && !selectedVolume) ||
                          (hasWeights && !selectedWeight)
                            ? "cursor-not-allowed opacity-50"
                            : ""
                        }`}
                        onClick={handleAddToCart}
                        disabled={
                          isAdded ||
                          (hasSizes && !selectedSize) ||
                          (hasVolumes && !selectedVolume) ||
                          (hasWeights && !selectedWeight)
                        }
                        size="lg"
                      >
                        Add To Cart
                      </Button>
                    </>
                  ) : (
                    <Button
                      className="cursor-not-allowed rounded-md border-2 border-black bg-gray-300 px-6 py-2 font-bold text-gray-600 opacity-50 shadow-neo"
                      disabled
                      size="lg"
                    >
                      Sold Out
                    </Button>
                  )}

                  {/* Share - Light Blue */}
                  <Button
                    className="rounded-md border-2 border-black bg-blue-100 px-6 py-2 font-bold text-black shadow-neo transition-transform hover:-translate-y-0.5 hover:bg-blue-200 active:translate-y-0.5"
                    onClick={handleShare}
                    size="lg"
                  >
                    Share
                  </Button>
                </div>

                {/* Contact Seller */}
                {productData.pubkey !== userPubkey && (
                  <p className="text-sm text-black">
                    or{" "}
                    <span
                      onClick={() => handleSendMessage(productData.pubkey)}
                      className="cursor-pointer font-semibold underline hover:text-primary-blue"
                    >
                      contact seller
                    </span>
                  </p>
                )}
              </div>
            </div>

            {/* Product Reviews Section */}
            {!isFetchingReviews && productReviews && (
              <div className="mt-8">
                <h3 className="mb-4 text-2xl font-bold text-black">
                  Product Reviews
                </h3>
                {productReviews.size > 0 ? (
                  <div className="space-y-4">
                    {Array.from(productReviews.entries()).map(
                      ([reviewerPubkey, reviewData]) => (
                        <div
                          key={reviewerPubkey}
                          className="rounded-md border-2 border-black bg-white p-4 shadow-neo"
                        >
                          <div className="mb-3 flex items-center gap-2">
                            <ProfileWithDropdown
                              pubkey={reviewerPubkey}
                              dropDownKeys={
                                reviewerPubkey === userPubkey
                                  ? ["shop_profile"]
                                  : ["shop", "inquiry", "copy_npub"]
                              }
                            />
                          </div>
                          <div className="flex flex-col gap-2">
                            <div className="flex flex-wrap gap-2">
                              {reviewData.map(([_, value, category], index) => {
                                if (category === undefined) {
                                  return null;
                                } else if (category === "thumb") {
                                  return (
                                    <Chip
                                      key={index}
                                      className={`border-2 border-black font-bold shadow-neo ${
                                        value === "1"
                                          ? "bg-green-400"
                                          : "bg-red-400"
                                      }`}
                                    >
                                      {`overall: ${
                                        value === "1" ? "👍" : "👎"
                                      }`}
                                    </Chip>
                                  );
                                } else {
                                  return (
                                    <Chip
                                      key={index}
                                      className={`border-2 border-black font-bold shadow-neo ${
                                        value === "1"
                                          ? "bg-green-400"
                                          : "bg-red-400"
                                      }`}
                                    >
                                      {`${category}: ${
                                        value === "1" ? "👍" : "👎"
                                      }`}
                                    </Chip>
                                  );
                                }
                              })}
                            </div>
                            {reviewData.map(([category, value], index) => {
                              if (category === "comment" && value !== "") {
                                return (
                                  <p key={index} className="italic text-black">
                                    &ldquo;{value}&rdquo;
                                  </p>
                                );
                              }
                              return null;
                            })}
                          </div>
                        </div>
                      )
                    )}
                  </div>
                ) : (
                  <div className="rounded-md border-2 border-black bg-white p-10 text-center shadow-neo">
                    <p className="text-3xl font-bold text-black">
                      No reviews . . . yet!
                    </p>
                    <p className="mt-3 text-lg text-black">
                      Be the first to leave a review!
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <div className="flex flex-col items-center">
            <ProductInvoiceCard
              productData={updatedProductData}
              setFiatOrderIsPlaced={setFiatOrderIsPlaced}
              setFiatOrderFailed={setFiatOrderFailed}
              setInvoiceIsPaid={setInvoiceIsPaid}
              setInvoiceGenerationFailed={setInvoiceGenerationFailed}
              setCashuPaymentSent={setCashuPaymentSent}
              setCashuPaymentFailed={setCashuPaymentFailed}
              selectedSize={selectedSize}
              selectedVolume={selectedVolume}
              selectedWeight={selectedWeight}
              setIsBeingPaid={setIsBeingPaid}
            />
          </div>
        )}
        <SignInModal isOpen={isOpen} onClose={onClose} />
        <FailureModal
          bodyText={failureText}
          isOpen={showFailureModal}
          onClose={() => setShowFailureModal(false)}
        />
        <SuccessModal
          bodyText="Listing URL copied to clipboard!"
          isOpen={showSuccessModal}
          onClose={() => setShowSuccessModal(false)}
        />
      </div>
    </div>
  );
}
