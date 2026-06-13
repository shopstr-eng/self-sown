import { useState, useEffect, useMemo, useContext } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Dropdown,
  DropdownTrigger,
  DropdownMenu,
  DropdownItem,
  Button,
} from "@heroui/react";
import { XCircleIcon, EllipsisVerticalIcon } from "@heroicons/react/24/outline";
import { BLUEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import CheckoutCard from "@/components/utility-components/checkout-card";
import ZapsnagButton from "@/components/ZapsnagButton";
import { ShopMapContext } from "@/utils/context/context";
import {
  RawEventModal,
  EventIdModal,
} from "@/components/utility-components/modals/event-modals";
import ProductPageRenderer from "@/components/storefront/product-page-renderer";
import FormattedText from "@/components/storefront/formatted-text";
import MilkMarketSpinner from "@/components/utility-components/mm-spinner";
import { NostrEvent } from "@/utils/types/types";

function buildProductJsonLd(
  product: ProductData,
  shopName?: string
): Record<string, unknown> | null {
  if (!product?.title) return null;
  const cfg = product.pageConfig;
  const galleryImages =
    cfg?.sections?.find(
      (s) => s.type === "product_gallery" && s.galleryImages?.length
    )?.galleryImages || [];
  const images = [...(product.images || []), ...galleryImages].filter(Boolean);
  const description = cfg?.metaDescription || product.summary || product.title;
  const availability =
    product.status && product.status !== "active"
      ? "https://schema.org/OutOfStock"
      : "https://schema.org/InStock";
  const price =
    product.totalCost && product.totalCost > 0
      ? product.totalCost
      : product.price;
  const ld: Record<string, unknown> = {
    "@context": "https://schema.org/",
    "@type": "Product",
    name: cfg?.metaTitle || product.title,
    description,
  };
  if (images.length > 0) ld.image = images;
  if (product.d) ld.sku = product.d;
  if (shopName) {
    ld.brand = { "@type": "Brand", name: shopName };
  }
  if (price && product.currency) {
    ld.offers = {
      "@type": "Offer",
      priceCurrency: product.currency,
      price: String(price),
      availability,
    };
  }
  return ld;
}

interface ProductListingViewProps {
  productData: ProductData | undefined;
  rawEvent: NostrEvent | undefined;
  isZapsnag: boolean;
  isListingNotFound?: boolean;
  // Top padding to clear the fixed nav. The standalone listing page uses the
  // global navbar (pt-20); embedded in a storefront chrome it should match that
  // chrome's nav height (e.g. pt-14).
  topPaddingClass?: string;
}

// The full product experience — CheckoutCard plus the customizable
// ProductPageRenderer sections, with all payment state, post-payment redirect,
// and zapsnag/raw-event handling. Rendered both by the standalone listing page
// and by a storefront root that serves a product as its landing page.
export default function ProductListingView({
  productData,
  rawEvent,
  isZapsnag,
  isListingNotFound = false,
  topPaddingClass = "pt-20",
}: ProductListingViewProps) {
  const router = useRouter();
  const shopMapContext = useContext(ShopMapContext);

  const [showRawEventModal, setShowRawEventModal] = useState(false);
  const [showEventIdModal, setShowEventIdModal] = useState(false);

  const [fiatOrderIsPlaced, setFiatOrderIsPlaced] = useState(false);
  const [fiatOrderFailed, setFiatOrderFailed] = useState(false);
  const [invoiceIsPaid, setInvoiceIsPaid] = useState(false);
  const [invoiceGenerationFailed, setInvoiceGenerationFailed] = useState(false);
  const [cashuPaymentSent, setCashuPaymentSent] = useState(false);
  const [cashuPaymentFailed, setCashuPaymentFailed] = useState(false);

  // Once payment lands, let the inline confirmation render briefly and then
  // push straight to the order summary (or storefront confirmation if the
  // listing was opened from a custom storefront). Avoids the prior friction
  // of a "click X to dismiss" success modal.
  useEffect(() => {
    if (!fiatOrderIsPlaced && !invoiceIsPaid && !cashuPaymentSent) return;
    const timer = setTimeout(() => {
      setFiatOrderIsPlaced(false);
      setInvoiceIsPaid(false);
      setCashuPaymentSent(false);
      const sfSlug =
        typeof window !== "undefined"
          ? sessionStorage.getItem("sf_shop_slug")
          : null;
      const sfPk =
        typeof window !== "undefined"
          ? sessionStorage.getItem("sf_seller_pubkey")
          : null;
      if (sfPk && sfSlug) {
        router.push(`/stall/${sfSlug}/order-confirmation`);
      } else {
        router.push("/order-summary");
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, [fiatOrderIsPlaced, invoiceIsPaid, cashuPaymentSent, router]);

  const sellerPubkey = productData?.pubkey || "";

  const productJsonLd = useMemo(() => {
    if (!productData || isZapsnag) return null;
    const shopName = shopMapContext?.shopData?.get(sellerPubkey)?.content?.name;
    return buildProductJsonLd(productData, shopName);
  }, [productData, isZapsnag, shopMapContext?.shopData, sellerPubkey]);

  return (
    <>
      {productJsonLd && (
        <Head>
          <script
            type="application/ld+json"
            dangerouslySetInnerHTML={{
              __html: JSON.stringify(productJsonLd),
            }}
          />
        </Head>
      )}
      <div
        className={`flex h-full min-h-screen flex-col bg-white ${topPaddingClass}`}
      >
        {productData ? (
          isZapsnag ? (
            <div className="mx-auto w-full max-w-2xl p-6">
              <div className="overflow-hidden rounded-xl bg-white shadow-lg">
                <img
                  src={productData.images[0]}
                  className="h-96 w-full object-cover"
                />
                <div className="p-6">
                  <div className="justify-dark mb-2 flex items-start">
                    <h1 className="text-2xl font-bold text-black">
                      {productData.title}
                    </h1>
                    {rawEvent && (
                      <Dropdown>
                        <DropdownTrigger>
                          <Button isIconOnly variant="light" size="sm">
                            <EllipsisVerticalIcon className="h-6 w-6 text-gray-500" />
                          </Button>
                        </DropdownTrigger>
                        <DropdownMenu aria-label="Event Actions">
                          <DropdownItem
                            key="view-raw"
                            onPress={() => setShowRawEventModal(true)}
                          >
                            View Raw Event
                          </DropdownItem>
                          <DropdownItem
                            key="view-id"
                            onPress={() => setShowEventIdModal(true)}
                          >
                            View Event ID
                          </DropdownItem>
                        </DropdownMenu>
                      </Dropdown>
                    )}
                  </div>
                  <FormattedText
                    as="p"
                    text={productData.summary || ""}
                    className="mb-6 whitespace-pre-wrap text-gray-600"
                  />
                  <ZapsnagButton product={productData} />
                </div>
              </div>

              {/* Raw Event Modal */}
              <RawEventModal
                isOpen={showRawEventModal}
                onClose={() => setShowRawEventModal(false)}
                rawEvent={rawEvent}
              />

              {/* Event ID Modal */}
              <EventIdModal
                isOpen={showEventIdModal}
                onClose={() => setShowEventIdModal(false)}
                rawEvent={rawEvent}
              />
            </div>
          ) : (
            <>
              <CheckoutCard
                key={productData.id}
                productData={productData}
                setFiatOrderIsPlaced={setFiatOrderIsPlaced}
                setFiatOrderFailed={setFiatOrderFailed}
                setInvoiceIsPaid={setInvoiceIsPaid}
                setInvoiceGenerationFailed={setInvoiceGenerationFailed}
                setCashuPaymentSent={setCashuPaymentSent}
                setCashuPaymentFailed={setCashuPaymentFailed}
                rawEvent={rawEvent}
              />
              <ProductPageRenderer
                product={productData}
                sellerPubkey={sellerPubkey}
              />
            </>
          )
        ) : isListingNotFound ? (
          <div className="flex min-h-[60vh] flex-col items-center justify-center px-4">
            <div className="shadow-neo w-full max-w-2xl rounded-md border-2 border-black bg-white px-8 pt-8 pb-8 text-center">
              <h1 className="mb-2 text-5xl font-bold text-black">404</h1>
              <h2 className="mb-6 text-2xl font-medium text-black md:text-3xl">
                Listing Not Found
              </h2>
              <p className="mb-8 text-black">
                This listing doesn&apos;t exist, hasn&apos;t synced yet, or is
                no longer available from your current data sources.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-4">
                <Button
                  className={BLUEBUTTONCLASSNAMES}
                  onPress={() => router.back()}
                >
                  Go back
                </Button>
                <Button
                  className={BLUEBUTTONCLASSNAMES}
                  onPress={() => router.push("/marketplace")}
                >
                  View marketplace
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-[60vh] items-center justify-center">
            <MilkMarketSpinner />
          </div>
        )}
        {invoiceGenerationFailed ? (
          <>
            <Modal
              backdrop="blur"
              isOpen={invoiceGenerationFailed}
              onClose={() => setInvoiceGenerationFailed(false)}
              classNames={{
                body: "py-6 bg-white",
                backdrop: "bg-black/50 backdrop-opacity-60",
                header: "border-b-4 border-black bg-white rounded-t-lg",
                footer: "border-t-4 border-black bg-white rounded-b-lg",
                closeButton: "hover:bg-gray-100 active:bg-gray-200",
                base: "border-4 border-black shadow-neo rounded-lg",
              }}
              isDismissable={true}
              scrollBehavior={"normal"}
              placement={"center"}
              size="2xl"
            >
              <ModalContent>
                <ModalHeader className="flex items-center justify-center text-black">
                  <XCircleIcon className="h-6 w-6 text-red-600" />
                  <div className="ml-2 font-bold">
                    Invoice generation failed!
                  </div>
                </ModalHeader>
                <ModalBody className="flex flex-col overflow-hidden text-black">
                  <div className="flex items-center justify-center font-medium">
                    The price and/or currency set for this listing was invalid.
                  </div>
                </ModalBody>
              </ModalContent>
            </Modal>
          </>
        ) : null}
        {cashuPaymentFailed ? (
          <>
            <Modal
              backdrop="blur"
              isOpen={cashuPaymentFailed}
              onClose={() => setCashuPaymentFailed(false)}
              classNames={{
                body: "py-6 bg-white",
                backdrop: "bg-black/50 backdrop-opacity-60",
                header: "border-b-4 border-black bg-white rounded-t-lg",
                footer: "border-t-4 border-black bg-white rounded-b-lg",
                closeButton: "hover:bg-gray-100 active:bg-gray-200",
                base: "border-4 border-black shadow-neo rounded-lg",
              }}
              isDismissable={true}
              scrollBehavior={"normal"}
              placement={"center"}
              size="2xl"
            >
              <ModalContent>
                <ModalHeader className="flex items-center justify-center text-black">
                  <XCircleIcon className="h-6 w-6 text-red-600" />
                  <div className="ml-2 font-bold">Purchase failed!</div>
                </ModalHeader>
                <ModalBody className="flex flex-col overflow-hidden text-black">
                  <div className="flex items-center justify-center font-medium">
                    You didn&apos;t have enough balance in your wallet to pay.
                  </div>
                </ModalBody>
              </ModalContent>
            </Modal>
          </>
        ) : null}
        {fiatOrderFailed ? (
          <>
            <Modal
              backdrop="blur"
              isOpen={fiatOrderFailed}
              onClose={() => setFiatOrderFailed(false)}
              classNames={{
                body: "py-6 bg-white",
                backdrop: "bg-black/50 backdrop-opacity-60",
                header: "border-b-4 border-black bg-white rounded-t-lg",
                footer: "border-t-4 border-black bg-white rounded-b-lg",
                closeButton: "hover:bg-gray-100 active:bg-gray-200",
                base: "border-4 border-black shadow-neo rounded-lg",
              }}
              isDismissable={true}
              scrollBehavior={"normal"}
              placement={"center"}
              size="2xl"
            >
              <ModalContent>
                <ModalHeader className="flex items-center justify-center text-black">
                  <XCircleIcon className="h-6 w-6 text-red-600" />
                  <div className="ml-2 font-bold">Order failed!</div>
                </ModalHeader>
                <ModalBody className="flex flex-col overflow-hidden text-black">
                  <div className="flex items-center justify-center font-medium">
                    Your order information was not delivered to the seller.
                    Please try again.
                  </div>
                </ModalBody>
              </ModalContent>
            </Modal>
          </>
        ) : null}
      </div>
    </>
  );
}
