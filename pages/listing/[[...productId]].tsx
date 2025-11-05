import React, { useState, useEffect, useContext } from "react";
import { useRouter } from "next/router";
import { Modal, ModalContent, ModalHeader, ModalBody } from "@nextui-org/react";
import { CheckCircleIcon, XCircleIcon } from "@heroicons/react/24/outline";
import parseTags, {
  ProductData,
} from "@/utils/parsers/product-parser-functions";
import CheckoutCard from "../../components/utility-components/checkout-card";
import { ProductContext } from "../../utils/context/context";
import { Event, nip19 } from "nostr-tools";

const Listing = () => {
  const router = useRouter();
  const [productData, setProductData] = useState<ProductData | undefined>(
    undefined
  );
  const [productIdString, setProductIdString] = useState("");

  const [fiatOrderIsPlaced, setFiatOrderIsPlaced] = useState(false);
  const [fiatOrderFailed, setFiatOrderFailed] = useState(false);
  const [invoiceIsPaid, setInvoiceIsPaid] = useState(false);
  const [invoiceGenerationFailed, setInvoiceGenerationFailed] = useState(false);
  const [cashuPaymentSent, setCashuPaymentSent] = useState(false);
  const [cashuPaymentFailed, setCashuPaymentFailed] = useState(false);

  const productContext = useContext(ProductContext);

  useEffect(() => {
    if (router.isReady) {
      const { productId } = router.query;
      const productIdString = productId ? productId[0] : "";
      setProductIdString(productIdString!);
      if (!productIdString) {
        router.push("/marketplace"); // if there isn't a productId, redirect to home page
      }
    }
  }, [router]);

  useEffect(() => {
    if (!productContext.isLoading && productContext.productEvents) {
      const matchingEvent = productContext.productEvents.find(
        (event: Event) => {
          // check for matching naddr
          const naddrMatch =
            nip19.naddrEncode({
              identifier:
                event.tags.find((tag: string[]) => tag[0] === "d")?.[1] || "",
              pubkey: event.pubkey,
              kind: event.kind,
            }) === productIdString;

          // Check for matching d tag
          const dTagMatch =
            event.tags.find((tag: string[]) => tag[0] === "d")?.[1] ===
            productIdString;
          // Check for matching event id
          const idMatch = event.id === productIdString;
          return naddrMatch || dTagMatch || idMatch;
        }
      );

      if (matchingEvent) {
        const parsed = parseTags(matchingEvent);
        setProductData(parsed);
      }
    }
  }, [productContext.isLoading, productContext.productEvents, productIdString]);

  return (
    <>
      <div className="flex h-full min-h-screen flex-col bg-white pt-20">
        {productData && (
          <CheckoutCard
            productData={productData}
            setFiatOrderIsPlaced={setFiatOrderIsPlaced}
            setFiatOrderFailed={setFiatOrderFailed}
            setInvoiceIsPaid={setInvoiceIsPaid}
            setInvoiceGenerationFailed={setInvoiceGenerationFailed}
            setCashuPaymentSent={setCashuPaymentSent}
            setCashuPaymentFailed={setCashuPaymentFailed}
          />
        )}
        {fiatOrderIsPlaced || invoiceIsPaid || cashuPaymentSent ? (
          <>
            <Modal
              backdrop="blur"
              isOpen={fiatOrderIsPlaced || invoiceIsPaid || cashuPaymentSent}
              onClose={() => {
                setFiatOrderIsPlaced(false);
                setInvoiceIsPaid(false);
                setCashuPaymentSent(false);
                router.push("/orders");
              }}
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
                  <CheckCircleIcon className="h-6 w-6 text-green-600" />
                  <div className="ml-2 font-bold">Order successful!</div>
                </ModalHeader>
                <ModalBody className="flex flex-col overflow-hidden text-black">
                  <div className="flex items-center justify-center font-medium">
                    The seller will receive a message with your order details.
                  </div>
                </ModalBody>
              </ModalContent>
            </Modal>
          </>
        ) : null}
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
};

export default Listing;
