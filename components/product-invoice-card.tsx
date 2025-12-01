import React, { useContext, useState, useEffect } from "react";
import {
  CashuWalletContext,
  ChatsContext,
  ProfileMapContext,
} from "../utils/context/context";
import { useForm } from "react-hook-form";
import {
  Button,
  Image,
  useDisclosure,
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  Select,
  SelectItem,
  Input,
  Textarea,
} from "@nextui-org/react";
import {
  BanknotesIcon,
  BoltIcon,
  CheckIcon,
  ClipboardIcon,
  CurrencyDollarIcon,
  WalletIcon,
} from "@heroicons/react/24/outline";
import { fiat } from "@getalby/lightning-tools";
import {
  CashuMint,
  CashuWallet,
  getEncodedToken,
  MintKeyset,
  Proof,
} from "@cashu/cashu-ts";
import {
  constructGiftWrappedEvent,
  constructMessageSeal,
  constructMessageGiftWrap,
  sendGiftWrappedMessageEvent,
  getLocalStorageData,
  publishProofEvent,
  generateKeys,
} from "@/utils/nostr/nostr-helper-functions";
import { addChatMessagesToCache } from "@/utils/nostr/cache-service";
import { LightningAddress } from "@getalby/lightning-tools";
import QRCode from "qrcode";
import { v4 as uuidv4 } from "uuid";
import { nip19 } from "nostr-tools";
import { webln } from "@getalby/sdk";
import { ProductData } from "@/utils/parsers/product-parser-functions";
import { formatWithCommas } from "./utility-components/display-monetary-info";
import SignInModal from "./sign-in/SignInModal";
import currencySelection from "../public/currencySelection.json";
import FailureModal from "@/components/utility-components/failure-modal";
import CountryDropdown from "./utility-components/dropdowns/country-dropdown";
import {
  NostrContext,
  SignerContext,
} from "@/components/utility-components/nostr-context-provider";
import { ShippingFormData, ContactFormData } from "@/utils/types/types";
import { Controller } from "react-hook-form";

export default function ProductInvoiceCard({
  productData,
  setIsBeingPaid,
  setFiatOrderIsPlaced,
  setFiatOrderFailed,
  setInvoiceIsPaid,
  setInvoiceGenerationFailed,
  setCashuPaymentSent,
  setCashuPaymentFailed,
  selectedSize,
  selectedVolume,
  selectedWeight,
  discountCode,
  discountPercentage,
  originalPrice,
}: {
  productData: ProductData;
  setIsBeingPaid: (isBeingPaid: boolean) => void;
  setFiatOrderIsPlaced: (fiatOrderIsPlaced: boolean) => void;
  setFiatOrderFailed: (fiatOrderFailed: boolean) => void;
  setInvoiceIsPaid: (invoiceIsPaid: boolean) => void;
  setInvoiceGenerationFailed: (invoiceGenerationFailed: boolean) => void;
  setCashuPaymentSent: (cashuPaymentSent: boolean) => void;
  setCashuPaymentFailed: (cashuPaymentFailed: boolean) => void;
  selectedSize?: string;
  selectedVolume?: string;
  selectedWeight?: string;
  discountCode?: string;
  discountPercentage?: number;
  originalPrice?: number;
}) {
  const { mints, tokens, history } = getLocalStorageData();
  const {
    pubkey: userPubkey,
    npub: userNPub,
    isLoggedIn,
    signer,
  } = useContext(SignerContext);

  // Check if there are tokens available for Cashu payment
  const hasTokensAvailable = tokens && tokens.length > 0;
  const chatsContext = useContext(ChatsContext);
  const profileContext = useContext(ProfileMapContext);

  const { nostr } = useContext(NostrContext);

  const [showInvoiceCard, setShowInvoiceCard] = useState(false);

  const [paymentConfirmed, setPaymentConfirmed] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState<string | null>(null);
  const [invoice, setInvoice] = useState("");
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);

  const [orderConfirmed, setOrderConfirmed] = useState(false);

  const walletContext = useContext(CashuWalletContext);

  const [randomNpubForSender, setRandomNpubForSender] = useState<string>("");
  const [randomNsecForSender, setRandomNsecForSender] = useState<string>("");
  const [randomNpubForReceiver, setRandomNpubForReceiver] =
    useState<string>("");
  const [randomNsecForReceiver, setRandomNsecForReceiver] =
    useState<string>("");

  const { isOpen, onOpen, onClose } = useDisclosure();

  const [formType, setFormType] = useState<"shipping" | "contact" | null>(null);
  const [showOrderTypeSelection, setShowOrderTypeSelection] = useState(true);

  const [fiatPaymentOptions, setFiatPaymentOptions] = useState({});
  const [showFiatTypeOption, setShowFiatTypeOption] = useState(false);
  const [selectedFiatOption, setSelectedFiatOption] = useState("");
  const [isNwcLoading, setIsNwcLoading] = useState(false);
  const [nwcInfo, setNwcInfo] = useState<any | null>(null);
  const [showFiatPaymentInstructions, setShowFiatPaymentInstructions] =
    useState(false);
  const [fiatPaymentConfirmed, setFiatPaymentConfirmed] = useState(false);

  // State for failure modal
  const [showFailureModal, setShowFailureModal] = useState(false);
  const [failureText, setFailureText] = useState("");

  // Stripe payment states
  const [stripeInvoiceUrl, setStripeInvoiceUrl] = useState<string | null>(null);
  const [_stripeInvoiceId, setStripeInvoiceId] = useState<string | null>(null);
  const [isCheckingStripePayment, setIsCheckingStripePayment] = useState(false);
  const [stripePaymentConfirmed, setStripePaymentConfirmed] = useState(false);
  const [stripeTimeoutSeconds, setStripeTimeoutSeconds] = useState<number>(600); // 10 minutes
  const [hasTimedOut, setHasTimedOut] = useState(false);

  // Timeout constants
  const STRIPE_TIMEOUT_SECONDS = 600; // 10 minutes total timeout

  const [isFormValid, setIsFormValid] = useState(false);
  const [pendingPaymentData, setPendingPaymentData] = useState<any>(null);

  const {
    handleSubmit: handleFormSubmit,
    control: formControl,
    watch,
  } = useForm();

  // Watch form values to validate completion
  const watchedValues = watch();
  const [selectedPickupLocation, setSelectedPickupLocation] = useState<
    string | null
  >(null);

  // Check if Stripe should be available for this product
  const isStripeMerchant =
    productData.pubkey === process.env.NEXT_PUBLIC_MILK_MARKET_PK;

  useEffect(() => {
    const fetchKeys = async () => {
      const { nsec: nsecForSender, npub: npubForSender } = await generateKeys();
      setRandomNpubForSender(npubForSender);
      setRandomNsecForSender(nsecForSender);
      const { nsec: nsecForReceiver, npub: npubForReceiver } =
        await generateKeys();
      setRandomNpubForReceiver(npubForReceiver);
      setRandomNsecForReceiver(nsecForReceiver);
    };

    fetchKeys();
  }, []);

  useEffect(() => {
    const sellerProfile = profileContext.profileData.get(productData.pubkey);
    const fiatOptions = sellerProfile?.content?.fiat_options || {};
    setFiatPaymentOptions(fiatOptions);
    const loadNwcInfo = () => {
      const { nwcInfo: infoString } = getLocalStorageData();
      if (infoString) {
        try {
          const info = JSON.parse(infoString);
          setNwcInfo(info);
        } catch (e) {
          console.error("Failed to parse NWC info", e);
          setNwcInfo(null);
        }
      } else {
        setNwcInfo(null);
      }
    };
    loadNwcInfo();
    // Listen for storage changes (e.g., user disconnects wallet in settings)
    window.addEventListener("storage", loadNwcInfo);
    return () => window.removeEventListener("storage", loadNwcInfo);
  }, [productData.pubkey, profileContext.profileData]);

  // Stripe payment timeout countdown
  useEffect(() => {
    if (!stripeInvoiceUrl || stripePaymentConfirmed || hasTimedOut) {
      return;
    }

    const interval = setInterval(() => {
      setStripeTimeoutSeconds((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          setHasTimedOut(true);
          setIsCheckingStripePayment(false);
          setShowInvoiceCard(false);
          setStripeInvoiceUrl(null);
          setStripeInvoiceId(null);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [stripeInvoiceUrl, stripePaymentConfirmed, hasTimedOut]);

  // Validate form completion
  useEffect(() => {
    if (!formType || !watchedValues) {
      setIsFormValid(false);
      return;
    }

    let isValid = false;

    if (formType === "shipping") {
      isValid = !!(
        watchedValues.Name?.trim() &&
        watchedValues.Address?.trim() &&
        watchedValues.City?.trim() &&
        watchedValues["Postal Code"]?.trim() &&
        watchedValues["State/Province"]?.trim() &&
        watchedValues.Country?.trim() &&
        (!productData.required || watchedValues.Required?.trim())
      );
    } else if (formType === "contact") {
      isValid = !!(
        watchedValues.Contact?.trim() &&
        watchedValues["Contact Type"]?.trim() &&
        watchedValues.Instructions?.trim() &&
        (!productData.required || watchedValues.Required?.trim())
      );
    }

    setIsFormValid(isValid);
  }, [watchedValues, formType, productData.required]);

  const sendPaymentAndContactMessage = async (
    pubkeyToReceiveMessage: string,
    message: string,
    isPayment?: boolean,
    isReceipt?: boolean,
    isDonation?: boolean,
    isHerdshare?: boolean,
    orderId?: string,
    paymentType?: string,
    paymentReference?: string,
    paymentProof?: string,
    messageAmount?: number,
    retryCount: number = 3
  ) => {
    const decodedRandomPubkeyForSender = nip19.decode(randomNpubForSender);
    const decodedRandomPrivkeyForSender = nip19.decode(randomNsecForSender);
    const decodedRandomPubkeyForReceiver = nip19.decode(randomNpubForReceiver);
    const decodedRandomPrivkeyForReceiver = nip19.decode(randomNsecForReceiver);

    let messageSubject = "";
    let messageOptions = {};
    if (isPayment) {
      messageSubject = "order-payment";
      messageOptions = {
        isOrder: true,
        type: 3,
        orderAmount: messageAmount
          ? messageAmount
          : formType === "shipping"
            ? productData.totalCost
            : productData.price,
        orderId,
        productData: {
          ...productData,
          selectedSize,
          selectedVolume,
          selectedWeight,
        },
        paymentType,
        paymentReference,
        paymentProof,
      };
    } else if (isReceipt) {
      messageSubject = "order-info";
      messageOptions = {
        isOrder: true,
        type: 4,
        orderId,
        productData: {
          ...productData,
          selectedSize,
          selectedVolume,
          selectedWeight,
        },
        status: "confirmed",
      };
    } else if (isDonation) {
      messageSubject = "donation";
    } else if (orderId || isHerdshare) {
      messageSubject = "order-info";
      messageOptions = {
        isOrder: true,
        type: 1,
        orderAmount: messageAmount ? messageAmount : undefined,
        orderId,
        productData: {
          ...productData,
          selectedSize,
          selectedVolume,
          selectedWeight,
        },
        quantity: 1,
      };
    }

    for (let attempt = 0; attempt < retryCount; attempt++) {
      try {
        const giftWrappedMessageEvent = await constructGiftWrappedEvent(
          decodedRandomPubkeyForSender.data as string,
          pubkeyToReceiveMessage,
          message,
          messageSubject,
          messageOptions
        );
        const sealedEvent = await constructMessageSeal(
          signer!,
          giftWrappedMessageEvent,
          decodedRandomPubkeyForSender.data as string,
          pubkeyToReceiveMessage,
          decodedRandomPrivkeyForSender.data as Uint8Array
        );
        const giftWrappedEvent = await constructMessageGiftWrap(
          sealedEvent,
          decodedRandomPubkeyForReceiver.data as string,
          decodedRandomPrivkeyForReceiver.data as Uint8Array,
          pubkeyToReceiveMessage
        );

        await sendGiftWrappedMessageEvent(nostr!, giftWrappedEvent);

        if (isReceipt || isHerdshare) {
          chatsContext.addNewlyCreatedMessageEvent(
            {
              ...giftWrappedMessageEvent,
              sig: "",
              read: false,
            },
            true
          );
          addChatMessagesToCache([
            { ...giftWrappedMessageEvent, sig: "", read: false },
          ]);
        }

        // If we get here, the message was sent successfully
        return;
      } catch (error) {
        console.warn(
          `Attempt ${attempt + 1} failed for message sending:`,
          error
        );

        if (attempt === retryCount - 1) {
          // This was the last attempt, log the error but don't throw
          console.error("Failed to send message after all retries:", error);
          return; // Continue with the flow instead of breaking it
        }

        // Wait before retrying (exponential backoff)
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 1000)
        );
      }
    }
  };

  const validatePaymentData = (
    price: number,
    data?: ShippingFormData | ContactFormData
  ) => {
    if (price < 1) {
      throw new Error("Payment amount must be greater than 0 sats");
    }

    if (data) {
      // Type guard to check which form data we received
      if ("Name" in data) {
        const shippingData = data as ShippingFormData;
        if (
          !shippingData.Name?.trim() ||
          !shippingData.Address?.trim() ||
          !shippingData.City?.trim() ||
          !shippingData["Postal Code"]?.trim() ||
          !shippingData["State/Province"]?.trim() ||
          !shippingData.Country?.trim()
        ) {
          throw new Error("Required shipping fields are missing");
        }
      } else if ("Contact" in data) {
        const contactData = data as ContactFormData;
        if (
          !contactData.Contact?.trim() ||
          !contactData["Contact Type"]?.trim() ||
          !contactData.Instructions?.trim()
        ) {
          throw new Error("Required contact fields are missing");
        }
      }
      if ("Required" in data && data["Required"] !== "") {
        if (!data["Required"]?.trim()) {
          throw new Error("Required fields are missing");
        }
      }
    }
  };

  const onFormSubmit = async (
    data: { [x: string]: string },
    paymentType?: "fiat" | "lightning" | "cashu" | "nwc" | "stripe"
  ) => {
    try {
      let price =
        formType === "shipping" ? productData.totalCost : productData.price;
      if (
        !currencySelection.hasOwnProperty(productData.currency.toUpperCase())
      ) {
        throw new Error(`${productData.currency} is not a supported currency.`);
      } else if (
        currencySelection.hasOwnProperty(productData.currency.toUpperCase()) &&
        productData.currency.toLowerCase() !== "sats" &&
        productData.currency.toLowerCase() !== "sat"
      ) {
        try {
          const currencyData = {
            amount: price,
            currency: productData.currency,
          };
          const numSats = await fiat.getSatoshiValue(currencyData);
          price = Math.round(numSats);
        } catch (err) {
          console.error("ERROR", err);
        }
      } else if (productData.currency.toLowerCase() === "btc") {
        price = price * 100000000;
      }

      if (price < 1) {
        throw new Error("Listing price is less than 1 sat.");
      }

      const commonData = {
        additionalInfo: data["Required"],
      };

      let paymentData: any = commonData;

      if (formType === "shipping") {
        paymentData = {
          ...paymentData,
          shippingName: data["Name"],
          shippingAddress: data["Address"],
          shippingUnitNo: data["Unit"],
          shippingCity: data["City"],
          shippingPostalCode: data["Postal Code"],
          shippingState: data["State/Province"],
          shippingCountry: data["Country"],
        };
      }

      if (formType === "contact") {
        paymentData = {
          ...paymentData,
          contact: data["Contact"],
          contactType: data["Contact Type"],
          contactInstructions: data["Instructions"],
        };
      }

      if (paymentType === "fiat") {
        setPendingPaymentData(paymentData); // Store the payment data
        const fiatOptionKeys = Object.keys(fiatPaymentOptions);
        if (fiatOptionKeys.length === 1) {
          setSelectedFiatOption(fiatOptionKeys[0]!);
          // Show payment instructions
          setShowFiatPaymentInstructions(true);
        } else if (fiatOptionKeys.length > 1) {
          setShowFiatTypeOption(true);
        }
        return; // Important: exit early for fiat payments
      } else if (paymentType === "cashu") {
        await handleCashuPayment(price, paymentData);
      } else if (paymentType === "nwc") {
        await handleNWCPayment(price, paymentData);
      } else if (paymentType === "stripe") {
        await handleStripePayment(price, paymentData);
      } else {
        await handleLightningPayment(price, paymentData);
      }
    } catch (error) {
      setCashuPaymentFailed(true);
    }
  };

  const handleOrderTypeSelection = (selectedOrderType: string) => {
    setShowOrderTypeSelection(false);

    if (selectedOrderType === "shipping") {
      setFormType("shipping");
    } else if (selectedOrderType === "contact") {
      setFormType("contact");
    }
  };

  const handleNWCError = (error: any) => {
    console.error("NWC Payment failed:", error);
    let message = "Payment failed. Please try again.";
    if (error && typeof error === "object" && "code" in error) {
      switch (error.code) {
        case "INSUFFICIENT_BALANCE":
          message = "Payment failed: Insufficient balance in your wallet.";
          break;
        case "QUOTA_EXCEEDED":
          message =
            "Payment failed: Your wallet's spending quota has been exceeded.";
          break;
        case "PAYMENT_FAILED":
          message =
            "The payment failed. Please check your wallet and try again.";
          break;
        case "RATE_LIMITED":
          message =
            "You are sending payments too quickly. Please wait a moment.";
          break;
        default:
          message = error.message || "An unknown wallet error occurred.";
      }
    } else if (error instanceof Error) {
      message = error.message;
    }
    setFailureText(`NWC Error: ${message}`);
    setShowFailureModal(true);
  };

  const handleNWCPayment = async (convertedPrice: number, data: any) => {
    setIsNwcLoading(true);
    let nwc: webln.NostrWebLNProvider | null = null;

    try {
      if (data.shippingName || data.shippingAddress) {
        validatePaymentData(convertedPrice, {
          Name: data.shippingName || "",
          Address: data.shippingAddress || "",
          Unit: data.shippingUnitNo || "",
          City: data.shippingCity || "",
          "Postal Code": data.shippingPostalCode || "",
          "State/Province": data.shippingState || "",
          Country: data.shippingCountry || "",
          Required: data.additionalInfo || "",
        });
      } else if (data.contact || data.contactType) {
        validatePaymentData(convertedPrice, {
          Contact: data.contact || "",
          "Contact Type": data.contactType || "",
          Instructions: data.contactInstructions || "",
          Required: data.additionalInfo || "",
        });
      } else {
        validatePaymentData(convertedPrice);
      }

      const wallet = new CashuWallet(new CashuMint(mints[0]!));
      const { request: pr, quote: hash } =
        await wallet.createMintQuote(convertedPrice);

      const { nwcString } = getLocalStorageData();
      if (!nwcString) throw new Error("NWC connection not found.");

      nwc = new webln.NostrWebLNProvider({ nostrWalletConnectUrl: nwcString });
      await nwc.enable();

      await nwc.sendPayment(pr);

      await invoiceHasBeenPaid(
        wallet,
        convertedPrice,
        hash,
        data.shippingName ? data.shippingName : undefined,
        data.shippingAddress ? data.shippingAddress : undefined,
        data.shippingUnitNo ? data.shippingUnitNo : undefined,
        data.shippingCity ? data.shippingCity : undefined,
        data.shippingPostalCode ? data.shippingPostalCode : undefined,
        data.shippingState ? data.shippingState : undefined,
        data.shippingCountry ? data.shippingCountry : undefined,
        data.contact ? data.contact : undefined,
        data.contactType ? data.contactType : undefined,
        data.contactInstructions ? data.contactInstructions : undefined,
        data.additionalInfo ? data.additionalInfo : undefined
      );
    } catch (error: any) {
      handleNWCError(error);
    } finally {
      nwc?.close();
      setIsNwcLoading(false);
    }
  };

  const handleFiatPayment = async (convertedPrice: number, data: any) => {
    try {
      if (
        data.shippingName ||
        data.shippingAddress ||
        data.shippingCity ||
        data.shippingPostalCode ||
        data.shippingState ||
        data.shippingCountry
      ) {
        validatePaymentData(convertedPrice, {
          Name: data.shippingName || "",
          Address: data.shippingAddress || "",
          Unit: data.shippingUnitNo || "",
          City: data.shippingCity || "",
          "Postal Code": data.shippingPostalCode || "",
          "State/Province": data.shippingState || "",
          Country: data.shippingCountry || "",
          Required: data.additionalInfo || "",
        });
      } else if (data.contact || data.contactType || data.contactInstructions) {
        validatePaymentData(convertedPrice, {
          Contact: data.contact || "",
          "Contact Type": data.contactType || "",
          Instructions: data.contactInstructions || "",
          Required: data.additionalInfo || "",
        });
      } else {
        validatePaymentData(convertedPrice);
      }
      const title = productData.title;
      const pubkey = productData.pubkey;
      const required = productData.required;
      const orderId = uuidv4();

      let productDetails = "";
      if (selectedSize) {
        productDetails += " in size " + selectedSize;
      }
      if (selectedVolume) {
        if (productDetails) {
          productDetails += " and a " + selectedVolume;
        } else {
          productDetails += " in a " + selectedVolume;
        }
      }
      if (selectedWeight) {
        if (productDetails) {
          productDetails += " and weighing " + selectedWeight;
        } else {
          productDetails += " weighing " + selectedWeight;
        }
      }
      if (selectedPickupLocation) {
        if (productDetails) {
          productDetails += " (pickup at: " + selectedPickupLocation + ")";
        } else {
          productDetails += " (pickup at: " + selectedPickupLocation + ")";
        }
      }

      let paymentMessage = "";
      paymentMessage =
        "You have received an order from " +
        userNPub +
        " for your " +
        title +
        " listing on milk.market" +
        productDetails +
        "! Check your " +
        selectedFiatOption +
        " account for the payment.";
      await sendPaymentAndContactMessage(
        pubkey,
        paymentMessage,
        true,
        false,
        false,
        false,
        orderId,
        "fiat",
        "",
        ""
      );

      if (required && required !== "") {
        if (data.additionalInfo) {
          const additionalMessage =
            "Additional customer information: " + data.additionalInfo;
          await sendPaymentAndContactMessage(
            pubkey,
            additionalMessage,
            false,
            false,
            false,
            false,
            orderId
          );
        }
      }

      // Send herdshare agreement if product has one
      if (productData.herdshareAgreement) {
        const herdshareMessage =
          "To finalize your purchase, sign and send the following herdshare agreement for the dairy: " +
          productData.herdshareAgreement;
        await sendPaymentAndContactMessage(
          userPubkey!,
          herdshareMessage,
          false,
          false,
          false,
          true,
          orderId
        );
      }

      if (
        !(
          data.shippingName === undefined &&
          data.shippingAddress === undefined &&
          data.shippingUnitNo === undefined &&
          data.shippingCity === undefined &&
          data.shippingPostalCode === undefined &&
          data.shippingState === undefined &&
          data.shippingCountry === undefined &&
          data.contact === undefined &&
          data.contactType === undefined &&
          data.contactInstructions === undefined
        )
      ) {
        if (
          productData.shippingType === "Added Cost" ||
          productData.shippingType === "Free" ||
          ((productData.shippingType === "Free/Pickup" ||
            productData.shippingType === "Added Cost/Pickup") &&
            formType === "shipping")
        ) {
          let productDetails = "";
          if (selectedSize) {
            productDetails += " in size " + selectedSize;
          }
          if (selectedVolume) {
            if (productDetails) {
              productDetails += " and a " + selectedVolume;
            } else {
              productDetails += " in a " + selectedVolume;
            }
          }
          if (selectedWeight) {
            if (productDetails) {
              productDetails += " and weighing " + selectedWeight;
            } else {
              productDetails += " weighing " + selectedWeight;
            }
          }
          if (selectedPickupLocation) {
            if (productDetails) {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            } else {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            }
          }

          let contactMessage = "";
          if (!data.shippingUnitNo) {
            contactMessage =
              "Please ship the product" +
              productDetails +
              " to " +
              data.shippingName +
              " at " +
              data.shippingAddress +
              ", " +
              data.shippingCity +
              ", " +
              data.shippingPostalCode +
              ", " +
              data.shippingState +
              ", " +
              data.shippingCountry +
              ".";
          } else {
            contactMessage =
              "Please ship the product" +
              productDetails +
              " to " +
              data.shippingName +
              " at " +
              data.shippingAddress +
              " " +
              data.shippingUnitNo +
              ", " +
              data.shippingCity +
              ", " +
              data.shippingPostalCode +
              ", " +
              data.shippingState +
              ", " +
              data.shippingCountry +
              ".";
          }
          await sendPaymentAndContactMessage(
            pubkey,
            contactMessage,
            false,
            false,
            false,
            false,
            orderId
          );
          const receiptMessage =
            "Your order for " +
            productData.title +
            productDetails +
            " was processed successfully! If applicable, you should be receiving delivery information from " +
            nip19.npubEncode(productData.pubkey) +
            " as soon as they review your order.";
          await sendPaymentAndContactMessage(
            userPubkey!,
            receiptMessage,
            false,
            true,
            false,
            false,
            orderId
          );
        } else if (
          productData.shippingType === "N/A" ||
          productData.shippingType === "Pickup" ||
          ((productData.shippingType === "Free/Pickup" ||
            productData.shippingType === "Added Cost/Pickup") &&
            formType === "contact")
        ) {
          let productDetails = "";
          if (selectedSize) {
            productDetails += " in size " + selectedSize;
          }
          if (selectedVolume) {
            if (productDetails) {
              productDetails += " and a " + selectedVolume;
            } else {
              productDetails += " in a " + selectedVolume;
            }
          }
          if (selectedWeight) {
            if (productDetails) {
              productDetails += " and weighing " + selectedWeight;
            } else {
              productDetails += " weighing " + selectedWeight;
            }
          }
          if (selectedPickupLocation) {
            if (productDetails) {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            } else {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            }
          }

          let contactMessage;
          let receiptMessage;
          if (productDetails) {
            contactMessage =
              "To finalize the sale of your " +
              title +
              " listing" +
              productDetails +
              " on milk.market, please contact " +
              data.contact +
              " over " +
              data.contactType +
              " using the following instructions: " +
              data.contactInstructions;
            receiptMessage =
              "Your order for " +
              productData.title +
              productDetails +
              " was processed successfully! If applicable, you should be receiving delivery information from " +
              nip19.npubEncode(productData.pubkey) +
              " as soon as they review your order.";
          } else {
            contactMessage =
              "To finalize the sale of your " +
              title +
              " listing on milk.market, please contact " +
              data.contact +
              " over " +
              data.contactType +
              " using the following instructions: " +
              data.contactInstructions;
            receiptMessage =
              "Your order for " +
              productData.title +
              " was processed successfully! If applicable, you should be receiving delivery information from " +
              nip19.npubEncode(productData.pubkey) +
              " as soon as they review your order.";
          }
          await sendPaymentAndContactMessage(
            pubkey,
            contactMessage,
            false,
            false,
            false,
            false,
            orderId
          );
          await sendPaymentAndContactMessage(
            userPubkey!,
            receiptMessage,
            false,
            true,
            false,
            false,
            orderId
          );
        }
      } else {
        let productDetails = "";
        if (selectedSize) {
          productDetails += " in size " + selectedSize;
        }
        if (selectedVolume) {
          if (productDetails) {
            productDetails += " and a " + selectedVolume;
          } else {
            productDetails += " in a " + selectedVolume;
          }
        }
        if (selectedWeight) {
          if (productDetails) {
            productDetails += " and weighing " + selectedWeight;
          } else {
            productDetails += " weighing " + selectedWeight;
          }
        }
        if (selectedPickupLocation) {
          if (productDetails) {
            productDetails += " (pickup at: " + selectedPickupLocation + ")";
          } else {
            productDetails += " (pickup at: " + selectedPickupLocation + ")";
          }
        }

        const receiptMessage =
          "Thank you for your purchase of " +
          productData.title +
          productDetails +
          " from " +
          nip19.npubEncode(productData.pubkey) +
          ".";
        await sendPaymentAndContactMessage(
          userPubkey!,
          receiptMessage,
          false,
          true, // isReceipt is true
          false,
          false,
          orderId
        );
      }
      setFiatOrderIsPlaced(true);
      setFormType(null);
      setOrderConfirmed(true);
    } catch (error) {
      setFiatOrderFailed(true);
    }
  };

  const handleLightningPayment = async (convertedPrice: number, data: any) => {
    try {
      if (
        data.shippingName ||
        data.shippingAddress ||
        data.shippingCity ||
        data.shippingPostalCode ||
        data.shippingState ||
        data.shippingCountry
      ) {
        validatePaymentData(convertedPrice, {
          Name: data.shippingName || "",
          Address: data.shippingAddress || "",
          Unit: data.shippingUnitNo || "",
          City: data.shippingCity || "",
          "Postal Code": data.shippingPostalCode || "",
          "State/Province": data.shippingState || "",
          Country: data.shippingCountry || "",
          Required: data.additionalInfo || "",
        });
      } else if (data.contact || data.contactType || data.contactInstructions) {
        validatePaymentData(convertedPrice, {
          Contact: data.contact || "",
          "Contact Type": data.contactType || "",
          Instructions: data.contactInstructions || "",
          Required: data.additionalInfo || "",
        });
      } else {
        validatePaymentData(convertedPrice);
      }

      setShowInvoiceCard(true);
      const wallet = new CashuWallet(new CashuMint(mints[0]!));

      const { request: pr, quote: hash } =
        await wallet.createMintQuote(convertedPrice);

      setInvoice(pr);

      QRCode.toDataURL(pr)
        .then((url: string) => {
          setQrCodeUrl(url);
        })
        .catch((err: unknown) => {
          console.error("ERROR", err);
        });

      if (typeof window.webln !== "undefined") {
        try {
          await window.webln.enable();
          const isEnabled = await window.webln.isEnabled();
          if (!isEnabled) {
            throw new Error("WebLN is not enabled");
          }
          try {
            const res = await window.webln.sendPayment(pr);
            if (!res) {
              throw new Error("Payment failed");
            }
          } catch (e) {
            console.error(e);
          }
        } catch (e) {
          console.error(e);
        }
      }
      await invoiceHasBeenPaid(
        wallet,
        convertedPrice,
        hash,
        data.shippingName ? data.shippingName : undefined,
        data.shippingAddress ? data.shippingAddress : undefined,
        data.shippingUnitNo ? data.shippingUnitNo : undefined,
        data.shippingCity ? data.shippingCity : undefined,
        data.shippingPostalCode ? data.shippingPostalCode : undefined,
        data.shippingState ? data.shippingState : undefined,
        data.shippingCountry ? data.shippingCountry : undefined,
        data.contact ? data.contact : undefined,
        data.contactType ? data.contactType : undefined,
        data.contactInstructions ? data.contactInstructions : undefined,
        data.additionalInfo ? data.additionalInfo : undefined
      );
    } catch (error) {
      setInvoiceGenerationFailed(true);
      setShowInvoiceCard(false);
      setInvoice("");
      setQrCodeUrl(null);
    }
  };

  /** CHECKS WHETHER INVOICE HAS BEEN PAID */
  async function invoiceHasBeenPaid(
    wallet: CashuWallet,
    newPrice: number,
    hash: string,
    shippingName?: string,
    shippingAddress?: string,
    shippingUnitNo?: string,
    shippingCity?: string,
    shippingPostalCode?: string,
    shippingState?: string,
    shippingCountry?: string,
    contact?: string,
    contactType?: string,
    contactInstructions?: string,
    additionalInfo?: string
  ) {
    let retryCount = 0;
    const maxRetries = 42; // Maximum 30 retries (about 1 minute)

    while (retryCount < maxRetries) {
      try {
        // First check if the quote has been paid
        const quoteState = await wallet.checkMintQuote(hash);

        if (quoteState.state === "PAID") {
          // Quote is paid, try to mint proofs
          try {
            const proofs = await wallet.mintProofs(newPrice, hash);
            if (proofs && proofs.length > 0) {
              await sendTokens(
                wallet,
                proofs,
                newPrice,
                shippingName ? shippingName : undefined,
                shippingAddress ? shippingAddress : undefined,
                shippingUnitNo ? shippingUnitNo : undefined,
                shippingCity ? shippingCity : undefined,
                shippingPostalCode ? shippingPostalCode : undefined,
                shippingState ? shippingState : undefined,
                shippingCountry ? shippingCountry : undefined,
                contact ? contact : undefined,
                contactType ? contactType : undefined,
                contactInstructions ? contactInstructions : undefined,
                additionalInfo ? additionalInfo : undefined
              );
              setPaymentConfirmed(true);
              setQrCodeUrl(null);
              setInvoiceIsPaid(true);
              break;
            }
          } catch (mintError) {
            // If minting fails but quote is paid, it might be already issued
            if (
              mintError instanceof Error &&
              mintError.message.includes("issued")
            ) {
              // Quote was already processed, consider it successful
              setPaymentConfirmed(true);
              setQrCodeUrl(null);
              setFailureText(
                "Payment was received but your connection dropped! Please check your wallet balance."
              );
              setShowFailureModal(true);
              break;
            }
            throw mintError;
          }
        } else if (quoteState.state === "ISSUED") {
          // Quote was already processed successfully
          setPaymentConfirmed(true);
          setQrCodeUrl(null);
          setFailureText(
            "Payment was received but your connection dropped! Please check your wallet balance."
          );
          setShowFailureModal(true);
          break;
        } else {
          // Quote not paid yet, continue waiting
          retryCount++;
          await new Promise((resolve) => setTimeout(resolve, 2100));
          continue;
        }
      } catch (error) {
        retryCount++;

        if (error instanceof TypeError) {
          setShowInvoiceCard(false);
          setInvoice("");
          setQrCodeUrl(null);
          setFailureText(
            "Failed to validate invoice! Change your mint in settings and/or please try again."
          );
          setShowFailureModal(true);
          break;
        }

        // If we've exceeded max retries, show error
        if (retryCount >= maxRetries) {
          setShowInvoiceCard(false);
          setInvoice("");
          setQrCodeUrl(null);
          setFailureText(
            "Payment timed out! Please check your wallet balance or try again."
          );
          setShowFailureModal(true);
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, 2100));
      }
    }
  }

  const sendTokens = async (
    wallet: CashuWallet,
    proofs: Proof[],
    totalPrice: number,
    shippingName?: string,
    shippingAddress?: string,
    shippingUnitNo?: string,
    shippingCity?: string,
    shippingPostalCode?: string,
    shippingState?: string,
    shippingCountry?: string,
    contact?: string,
    contactType?: string,
    contactInstructions?: string,
    additionalInfo?: string
  ) => {
    let remainingProofs = proofs;
    let sellerToken;
    let donationToken;
    const sellerProfile = profileContext.profileData.get(productData.pubkey);
    const donationPercentage = sellerProfile?.content?.shopstr_donation || 2.1;
    const donationAmount = Math.ceil((totalPrice * donationPercentage) / 100);
    const sellerAmount = totalPrice - donationAmount;
    let sellerProofs: Proof[] = [];

    if (sellerAmount > 0) {
      const { keep, send } = await wallet.send(sellerAmount, remainingProofs, {
        includeFees: true,
      });
      sellerProofs = send;
      sellerToken = getEncodedToken({
        mint: mints[0]!,
        proofs: send,
      });
      remainingProofs = keep;
    }

    if (donationAmount > 0) {
      const { keep, send } = await wallet.send(
        donationAmount,
        remainingProofs,
        {
          includeFees: true,
        }
      );
      donationToken = getEncodedToken({
        mint: mints[0]!,
        proofs: send,
      });
      remainingProofs = keep;
    }

    const orderId = uuidv4();
    const paymentPreference =
      sellerProfile?.content?.payment_preference || "ecash";
    const lnurl = sellerProfile?.content?.lud16 || "";

    // Step 1: Send payment message
    if (
      paymentPreference === "lightning" &&
      lnurl &&
      lnurl !== "" &&
      !lnurl.includes("@zeuspay.com") &&
      sellerProofs
    ) {
      const newAmount = Math.floor(sellerAmount * 0.98 - 2);
      const ln = new LightningAddress(lnurl);
      await wallet.loadMint();
      await ln.fetch();
      const invoice = await ln.requestInvoice({ satoshi: newAmount });
      const invoicePaymentRequest = invoice.paymentRequest;
      const meltQuote = await wallet.createMeltQuote(invoicePaymentRequest);
      if (meltQuote) {
        const meltQuoteTotal = meltQuote.amount + meltQuote.fee_reserve;
        const { keep, send } = await wallet.send(meltQuoteTotal, sellerProofs, {
          includeFees: true,
        });
        const meltResponse = await wallet.meltProofs(meltQuote, send);
        if (meltResponse.quote) {
          const meltAmount = meltResponse.quote.amount;
          const changeProofs = [...keep, ...meltResponse.change];
          const changeAmount =
            Array.isArray(changeProofs) && changeProofs.length > 0
              ? changeProofs.reduce(
                  (acc, current: Proof) => acc + current.amount,
                  0
                )
              : 0;
          let productDetails = "";
          if (selectedSize) {
            productDetails += " in size " + selectedSize;
          }
          if (selectedVolume) {
            if (productDetails) {
              productDetails += " and a " + selectedVolume;
            } else {
              productDetails += " in a " + selectedVolume;
            }
          }
          if (selectedWeight) {
            if (productDetails) {
              productDetails += " and weighing " + selectedWeight;
            } else {
              productDetails += " weighing " + selectedWeight;
            }
          }
          if (selectedPickupLocation) {
            if (productDetails) {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            } else {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            }
          }
          let paymentMessage = "";
          paymentMessage =
            "You have received a payment from " +
            userNPub +
            " for your " +
            productData.title +
            " listing" +
            productDetails +
            " on milk.market! Check your Lightning address (" +
            lnurl +
            ") for your sats.";
          await sendPaymentAndContactMessage(
            productData.pubkey,
            paymentMessage,
            true,
            false,
            false,
            false,
            orderId,
            "lightning",
            invoicePaymentRequest,
            invoice.preimage ? invoice.preimage : invoice.paymentHash,
            meltAmount
          );

          if (changeAmount >= 1 && changeProofs && changeProofs.length > 0) {
            // Add delay between messages to prevent browser throttling
            await new Promise((resolve) => setTimeout(resolve, 500));

            const encodedChange = getEncodedToken({
              mint: mints[0]!,
              proofs: changeProofs,
            });
            const changeMessage = "Overpaid fee change: " + encodedChange;
            try {
              await sendPaymentAndContactMessage(
                productData.pubkey,
                changeMessage,
                true,
                false,
                false,
                false,
                orderId,
                "ecash",
                mints[0],
                JSON.stringify(changeProofs),
                changeAmount
              );
              await new Promise((resolve) => setTimeout(resolve, 500));
            } catch (error) {
              console.error("Failed to send change message:", error);
            }
          }
        } else {
          const unusedProofs = [...keep, ...send, ...meltResponse.change];
          const unusedAmount =
            Array.isArray(unusedProofs) && unusedProofs.length > 0
              ? unusedProofs.reduce(
                  (acc, current: Proof) => acc + current.amount,
                  0
                )
              : 0;
          const unusedToken = getEncodedToken({
            mint: mints[0]!,
            proofs: unusedProofs,
          });
          let productDetails = "";
          if (selectedSize) {
            productDetails += " in size " + selectedSize;
          }
          if (selectedVolume) {
            if (productDetails) {
              productDetails += " and a " + selectedVolume;
            } else {
              productDetails += " in a " + selectedVolume;
            }
          }
          if (selectedWeight) {
            if (productDetails) {
              productDetails += " and weighing " + selectedWeight;
            } else {
              productDetails += " weighing " + selectedWeight;
            }
          }
          if (selectedPickupLocation) {
            if (productDetails) {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            } else {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            }
          }
          let paymentMessage = "";
          if (unusedToken && unusedProofs) {
            paymentMessage =
              "This is a Cashu token payment from " +
              userNPub +
              " for your " +
              productData.title +
              " listing" +
              productDetails +
              " on milk.market: " +
              unusedToken;
            await sendPaymentAndContactMessage(
              productData.pubkey,
              paymentMessage,
              true,
              false,
              false,
              false,
              orderId,
              "ecash",
              mints[0],
              JSON.stringify(unusedProofs),
              unusedAmount
            );
          }
        }
      }
    } else {
      let productDetails = "";
      if (selectedSize) {
        productDetails += " in size " + selectedSize;
      }
      if (selectedVolume) {
        if (productDetails) {
          productDetails += " and a " + selectedVolume;
        } else {
          productDetails += " in a " + selectedVolume;
        }
      }
      if (selectedWeight) {
        if (productDetails) {
          productDetails += " and weighing " + selectedWeight;
        } else {
          productDetails += " weighing " + selectedWeight;
        }
      }
      if (selectedPickupLocation) {
        if (productDetails) {
          productDetails += " (pickup at: " + selectedPickupLocation + ")";
        } else {
          productDetails += " (pickup at: " + selectedPickupLocation + ")";
        }
      }
      let paymentMessage = "";
      if (sellerToken && sellerProofs) {
        paymentMessage =
          "This is a Cashu token payment from " +
          userNPub +
          " for your " +
          productData.title +
          " listing" +
          productDetails +
          " on milk.market: " +
          sellerToken;
        await sendPaymentAndContactMessage(
          productData.pubkey,
          paymentMessage,
          true,
          false,
          false,
          false,
          orderId,
          "ecash",
          mints[0],
          JSON.stringify(sellerProofs),
          sellerAmount
        );
      }
    }

    // Step 2: Send donation message
    if (donationToken) {
      const donationMessage = "Sale donation: " + donationToken;
      try {
        await sendPaymentAndContactMessage(
          "a37118a4888e02d28e8767c08caaf73b49abdac391ad7ff18a304891e416dc33",
          donationMessage,
          false,
          false,
          true
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error("Failed to send donation message:", error);
      }
    }

    // Step 3: Send additional info message
    if (additionalInfo) {
      // Add delay between messages
      await new Promise((resolve) => setTimeout(resolve, 500));

      const additionalMessage =
        "Additional customer information: " + additionalInfo;
      try {
        await sendPaymentAndContactMessage(
          productData.pubkey,
          additionalMessage,
          false,
          false,
          false,
          false,
          orderId
        );
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        console.error("Failed to send additional info message:", error);
      }
    }

    // Send herdshare agreement if product has one
    if (productData.herdshareAgreement) {
      const herdshareMessage =
        "To finalize your purchase, sign and send the following herdshare agreement for the dairy: " +
        productData.herdshareAgreement;
      await sendPaymentAndContactMessage(
        userPubkey!,
        herdshareMessage,
        false,
        false,
        false,
        true,
        orderId
      );
    }

    // Step 4: Handle shipping and contact information
    if (
      shippingName &&
      shippingAddress &&
      shippingCity &&
      shippingPostalCode &&
      shippingState &&
      shippingCountry
    ) {
      if (
        productData.shippingType === "Added Cost" ||
        productData.shippingType === "Free" ||
        productData.shippingType === "Free/Pickup" ||
        productData.shippingType === "Added Cost/Pickup"
      ) {
        let productDetails = "";
        if (selectedSize) {
          productDetails += " in size " + selectedSize;
        }
        if (selectedVolume) {
          if (productDetails) {
            productDetails += " and a " + selectedVolume;
          } else {
            productDetails += " in a " + selectedVolume;
          }
        }
        if (selectedWeight) {
          if (productDetails) {
            productDetails += " and weighing " + selectedWeight;
          } else {
            productDetails += " weighing " + selectedWeight;
          }
        }
        if (selectedPickupLocation) {
          if (productDetails) {
            productDetails += " (pickup at: " + selectedPickupLocation + ")";
          } else {
            productDetails += " (pickup at: " + selectedPickupLocation + ")";
          }
        }

        let contactMessage = "";
        if (!shippingUnitNo) {
          contactMessage =
            "Please ship the product" +
            productDetails +
            " to " +
            shippingName +
            " at " +
            shippingAddress +
            ", " +
            shippingCity +
            ", " +
            shippingPostalCode +
            ", " +
            shippingState +
            ", " +
            shippingCountry +
            ".";
        } else {
          contactMessage =
            "Please ship the product" +
            productDetails +
            " to " +
            shippingName +
            " at " +
            shippingAddress +
            " " +
            shippingUnitNo +
            ", " +
            shippingCity +
            ", " +
            shippingPostalCode +
            ", " +
            shippingState +
            ", " +
            shippingCountry +
            ".";
        }
        await sendPaymentAndContactMessage(
          productData.pubkey,
          contactMessage,
          false,
          false,
          false,
          false,
          orderId
        );

        // Add delay between messages
        await new Promise((resolve) => setTimeout(resolve, 500));

        const receiptMessage =
          "Your order for " +
          productData.title +
          productDetails +
          " was processed successfully. If applicable, you should be receiving delivery information from " +
          nip19.npubEncode(productData.pubkey) +
          " as soon as they review your order.";
        await sendPaymentAndContactMessage(
          userPubkey!,
          receiptMessage,
          false,
          true,
          false,
          false,
          orderId
        );
      }
    } else if (contact && contactType && contactInstructions) {
      if (
        productData.shippingType === "N/A" ||
        productData.shippingType === "Pickup" ||
        productData.shippingType === "Free/Pickup" ||
        productData.shippingType === "Added Cost/Pickup"
      ) {
        let productDetails = "";
        if (selectedSize) {
          productDetails += " in size " + selectedSize;
        }
        if (selectedVolume) {
          if (productDetails) {
            productDetails += " and a " + selectedVolume;
          } else {
            productDetails += " in a " + selectedVolume;
          }
        }
        if (selectedWeight) {
          if (productDetails) {
            productDetails += " and weighing " + selectedWeight;
          } else {
            productDetails += " weighing " + selectedWeight;
          }
        }
        if (selectedPickupLocation) {
          if (productDetails) {
            productDetails += " (pickup at: " + selectedPickupLocation + ")";
          } else {
            productDetails += " (pickup at: " + selectedPickupLocation + ")";
          }
        }

        let contactMessage;
        let receiptMessage;
        if (productDetails) {
          contactMessage =
            "To finalize the sale of your " +
            productData.title +
            " listing" +
            productDetails +
            " on milk.market, please contact " +
            contact +
            " over " +
            contactType +
            " using the following instructions: " +
            contactInstructions;
          receiptMessage =
            "Your order for " +
            productData.title +
            productDetails +
            " was processed successfully! If applicable, you should be receiving delivery information from " +
            nip19.npubEncode(productData.pubkey) +
            " as soon as they review your order.";
        } else {
          contactMessage =
            "To finalize the sale of your " +
            productData.title +
            " listing on milk.market, please contact " +
            contact +
            " over " +
            contactType +
            " using the following instructions: " +
            contactInstructions;
          receiptMessage =
            "Your order for " +
            productData.title +
            " was processed successfully! If applicable, you should be receiving delivery information from " +
            nip19.npubEncode(productData.pubkey) +
            " as soon as they review your order.";
        }
        await sendPaymentAndContactMessage(
          productData.pubkey,
          contactMessage,
          false,
          false,
          false,
          false,
          orderId
        );

        // Add delay between messages
        await new Promise((resolve) => setTimeout(resolve, 500));

        await sendPaymentAndContactMessage(
          userPubkey!,
          receiptMessage,
          false,
          true,
          false,
          false,
          orderId
        );
      }
    } else {
      let productDetails = "";
      if (selectedSize) {
        productDetails += " in size " + selectedSize;
      }
      if (selectedVolume) {
        if (productDetails) {
          productDetails += " and a " + selectedVolume;
        } else {
          productDetails += " in a " + selectedVolume;
        }
      }
      if (selectedWeight) {
        if (productDetails) {
          productDetails += " and weighing " + selectedWeight;
        } else {
          productDetails += " weighing " + selectedWeight;
        }
      }
      if (selectedPickupLocation) {
        if (productDetails) {
          productDetails += " (pickup at: " + selectedPickupLocation + ")";
        } else {
          productDetails += " (pickup at: " + selectedPickupLocation + ")";
        }
      }

      const receiptMessage =
        "Thank you for your purchase of " +
        productData.title +
        productDetails +
        " from " +
        nip19.npubEncode(productData.pubkey) +
        ".";
      await sendPaymentAndContactMessage(
        userPubkey!,
        receiptMessage,
        false,
        true, // isReceipt is true
        false,
        false,
        orderId
      );
    }
  };

  const handleCopyInvoice = () => {
    navigator.clipboard.writeText(invoice);
    setCopiedToClipboard(true);
    setTimeout(() => {
      setCopiedToClipboard(false);
    }, 2100);
  };

  const formattedTotalCost = formatWithCommas(
    formType === "shipping" ? productData.totalCost : productData.price,
    productData.currency
  );

  const handleCashuPayment = async (price: number, data: any) => {
    try {
      if (!mints || mints.length === 0) {
        throw new Error("No Cashu mint available");
      }

      if (!walletContext) {
        throw new Error("Wallet context not available");
      }

      if (
        data.shippingName ||
        data.shippingAddress ||
        data.shippingCity ||
        data.shippingPostalCode ||
        data.shippingState ||
        data.shippingCountry
      ) {
        validatePaymentData(price, {
          Name: data.shippingName || "",
          Address: data.shippingAddress || "",
          Unit: data.shippingUnitNo || "",
          City: data.shippingCity || "",
          "Postal Code": data.shippingPostalCode || "",
          "State/Province": data.shippingState || "",
          Country: data.shippingCountry || "",
          Required: data.additionalInfo || "",
        });
      } else if (data.contact || data.contactType || data.contactInstructions) {
        validatePaymentData(price, {
          Contact: data.contact || "",
          "Contact Type": data.contactType || "",
          Instructions: data.contactInstructions || "",
          Required: data.additionalInfo || "",
        });
      } else {
        validatePaymentData(price);
      }

      const mint = new CashuMint(mints[0]!);
      const wallet = new CashuWallet(mint);
      const mintKeySetIds = await wallet.getKeySets();
      const filteredProofs = tokens.filter(
        (p: Proof) =>
          mintKeySetIds?.some((keysetId: MintKeyset) => keysetId.id === p.id)
      );
      const { keep, send } = await wallet.send(price, filteredProofs, {
        includeFees: true,
      });
      const deletedEventIds = [
        ...new Set([
          ...walletContext.proofEvents
            .filter((event) =>
              event.proofs.some((proof: Proof) =>
                filteredProofs.some(
                  (filteredProof) =>
                    JSON.stringify(proof) === JSON.stringify(filteredProof)
                )
              )
            )
            .map((event) => event.id),
          ...walletContext.proofEvents
            .filter((event) =>
              event.proofs.some((proof: Proof) =>
                keep.some(
                  (keepProof) =>
                    JSON.stringify(proof) === JSON.stringify(keepProof)
                )
              )
            )
            .map((event) => event.id),
          ...walletContext.proofEvents
            .filter((event) =>
              event.proofs.some((proof: Proof) =>
                send.some(
                  (sendProof) =>
                    JSON.stringify(proof) === JSON.stringify(sendProof)
                )
              )
            )
            .map((event) => event.id),
        ]),
      ];
      await sendTokens(
        wallet,
        send,
        price,
        data.shippingName ? data.shippingName : undefined,
        data.shippingAddress ? data.shippingAddress : undefined,
        data.shippingUnitNo ? data.shippingUnitNo : undefined,
        data.shippingCity ? data.shippingCity : undefined,
        data.shippingPostalCode ? data.shippingPostalCode : undefined,
        data.shippingState ? data.shippingState : undefined,
        data.shippingCountry ? data.shippingCountry : undefined,
        data.contact ? data.contact : undefined,
        data.contactType ? data.contactType : undefined,
        data.contactInstructions ? data.contactInstructions : undefined,
        data.additionalInfo ? data.additionalInfo : undefined
      );
      const changeProofs = keep;
      const remainingProofs = tokens.filter(
        (p: Proof) =>
          mintKeySetIds?.some((keysetId: MintKeyset) => keysetId.id !== p.id)
      );
      let proofArray;
      if (changeProofs.length >= 1 && changeProofs) {
        proofArray = [...remainingProofs, ...changeProofs];
      } else {
        proofArray = [...remainingProofs];
      }
      localStorage.setItem("tokens", JSON.stringify(proofArray));
      localStorage.setItem(
        "history",
        JSON.stringify([
          { type: 5, amount: price, date: Math.floor(Date.now() / 1000) },
          ...history,
        ])
      );
      await publishProofEvent(
        nostr!,
        signer!,
        mints[0]!,
        changeProofs && changeProofs.length >= 1 ? changeProofs : [],
        "out",
        price.toString(),
        deletedEventIds
      );
      setCashuPaymentSent(true);
    } catch (error) {
      setCashuPaymentFailed(true);
    }
  };

  const handleStripePayment = async (convertedPrice: number, data: any) => {
    try {
      // Validate payment data using converted price for validation
      if (
        data.shippingName ||
        data.shippingAddress ||
        data.shippingCity ||
        data.shippingPostalCode ||
        data.shippingState ||
        data.shippingCountry
      ) {
        validatePaymentData(convertedPrice, {
          Name: data.shippingName || "",
          Address: data.shippingAddress || "",
          Unit: data.shippingUnitNo || "",
          City: data.shippingCity || "",
          "Postal Code": data.shippingPostalCode || "",
          "State/Province": data.shippingState || "",
          Country: data.shippingCountry || "",
          Required: data.additionalInfo || "",
        });
      } else if (data.contact || data.contactType || data.contactInstructions) {
        validatePaymentData(convertedPrice, {
          Contact: data.contact || "",
          "Contact Type": data.contactType || "",
          Instructions: data.contactInstructions || "",
          Required: data.additionalInfo || "",
        });
      } else {
        validatePaymentData(convertedPrice);
      }

      const orderId = uuidv4();

      // Build shipping info if available
      let shippingInfo = undefined;
      if (data.shippingName && data.shippingAddress && data.shippingCity) {
        shippingInfo = {
          name: data.shippingName,
          address: data.shippingAddress,
          unit: data.shippingUnitNo || "",
          city: data.shippingCity,
          state: data.shippingState,
          postalCode: data.shippingPostalCode,
          country: data.shippingCountry,
        };
      }

      // Determine the amount and currency to send to Stripe
      // If currency is SAT, SATS, or BTC, we need to convert to USD
      // Otherwise, use the original price in the product's currency
      let stripeAmount: number;
      let stripeCurrency: string;

      const currencyLower = productData.currency.toLowerCase();
      const isCrypto =
        currencyLower === "sat" ||
        currencyLower === "sats" ||
        currencyLower === "btc";

      if (isCrypto) {
        // For crypto currencies, send the amount in sats to be converted by the API
        stripeAmount =
          formType === "shipping" ? productData.totalCost : productData.price;
        stripeCurrency = productData.currency;
      } else {
        // For fiat currencies, use the original price
        const basePrice =
          productData.volumePrice !== undefined
            ? productData.volumePrice
            : productData.weightPrice !== undefined
              ? productData.weightPrice
              : productData.price;

        stripeAmount =
          formType === "shipping"
            ? basePrice + (productData.shippingCost || 0)
            : basePrice;
        stripeCurrency = productData.currency;
      }

      // Create Stripe invoice
      const response = await fetch("/api/stripe/create-invoice", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: stripeAmount,
          currency: stripeCurrency,
          customerEmail: userPubkey
            ? `${userPubkey.substring(0, 8)}@nostr.com`
            : undefined,
          productTitle: productData.title,
          productDescription:
            selectedSize || selectedVolume || selectedWeight
              ? `${selectedSize ? `Size: ${selectedSize}` : ""}${
                  selectedVolume ? ` Volume: ${selectedVolume}` : ""
                }${selectedWeight ? ` Weight: ${selectedWeight}` : ""}`
              : undefined,
          shippingInfo,
          metadata: {
            orderId,
            productId: productData.id,
            sellerPubkey: productData.pubkey,
            buyerPubkey: userPubkey || "",
            productTitle: productData.title,
            selectedSize: selectedSize || "",
            selectedVolume: selectedVolume || "",
            selectedWeight: selectedWeight || "",
          },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.details || "Failed to create Stripe invoice");
      }

      const { invoiceUrl, invoiceId } = await response.json();

      setStripeInvoiceUrl(invoiceUrl);
      setStripeInvoiceId(invoiceId);
      setShowInvoiceCard(true);
      setStripeTimeoutSeconds(STRIPE_TIMEOUT_SECONDS);
      setHasTimedOut(false);

      // Start polling for payment status
      setIsCheckingStripePayment(true);
      checkStripePaymentStatus(invoiceId, data);
    } catch (error) {
      console.error("Stripe payment error:", error);
      setInvoiceGenerationFailed(true);
      setShowInvoiceCard(false);
    }
  };

  const checkStripePaymentStatus = async (invoiceId: string, data: any) => {
    let pollCount = 0;
    const maxPolls = 120; // Poll for up to 10 minutes (5 seconds * 120)

    const checkStatus = async () => {
      try {
        const response = await fetch("/api/stripe/check-payment", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ invoiceId }),
        });

        if (!response.ok) {
          throw new Error("Failed to check Stripe payment status");
        }

        const { paid } = await response.json();

        if (paid) {
          setStripePaymentConfirmed(true);
          setInvoiceIsPaid(true);
          setIsCheckingStripePayment(false);

          // Send payment confirmation messages
          const orderId = uuidv4();
          let productDetails = "";
          if (selectedSize) {
            productDetails += " in size " + selectedSize;
          }
          if (selectedVolume) {
            if (productDetails) {
              productDetails += " and a " + selectedVolume;
            } else {
              productDetails += " in a " + selectedVolume;
            }
          }
          if (selectedWeight) {
            if (productDetails) {
              productDetails += " and weighing " + selectedWeight;
            } else {
              productDetails += " weighing " + selectedWeight;
            }
          }
          if (selectedPickupLocation) {
            if (productDetails) {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            } else {
              productDetails += " (pickup at: " + selectedPickupLocation + ")";
            }
          }

          const paymentMessage =
            "You have received a credit card payment from " +
            userNPub +
            " for your " +
            productData.title +
            " listing" +
            productDetails +
            " on milk.market! Check your Stripe account for the payment.";

          await sendPaymentAndContactMessage(
            productData.pubkey,
            paymentMessage,
            true,
            false,
            false,
            false,
            orderId,
            "stripe",
            invoiceId,
            "",
            formType === "shipping" ? productData.totalCost : productData.price
          );

          // Send additional info and delivery messages similar to other payment methods
          if (data.additionalInfo) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const additionalMessage =
              "Additional customer information: " + data.additionalInfo;
            await sendPaymentAndContactMessage(
              productData.pubkey,
              additionalMessage,
              false,
              false,
              false,
              false,
              orderId
            );
          }

          if (productData.herdshareAgreement) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const herdshareMessage =
              "To finalize your purchase, sign and send the following herdshare agreement for the dairy: " +
              productData.herdshareAgreement;
            await sendPaymentAndContactMessage(
              userPubkey!,
              herdshareMessage,
              false,
              false,
              false,
              true,
              orderId
            );
          }

          // Handle shipping/contact information
          if (data.shippingName && data.shippingAddress) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            let contactMessage = "";
            if (!data.shippingUnitNo) {
              contactMessage =
                "Please ship the product" +
                productDetails +
                " to " +
                data.shippingName +
                " at " +
                data.shippingAddress +
                ", " +
                data.shippingCity +
                ", " +
                data.shippingPostalCode +
                ", " +
                data.shippingState +
                ", " +
                data.shippingCountry +
                ".";
            } else {
              contactMessage =
                "Please ship the product" +
                productDetails +
                " to " +
                data.shippingName +
                " at " +
                data.shippingAddress +
                " " +
                data.shippingUnitNo +
                ", " +
                data.shippingCity +
                ", " +
                data.shippingPostalCode +
                ", " +
                data.shippingState +
                ", " +
                data.shippingCountry +
                ".";
            }
            await sendPaymentAndContactMessage(
              productData.pubkey,
              contactMessage,
              false,
              false,
              false,
              false,
              orderId
            );

            await new Promise((resolve) => setTimeout(resolve, 500));
            const receiptMessage =
              "Your order for " +
              productData.title +
              productDetails +
              " was processed successfully. You should be receiving delivery information from " +
              nip19.npubEncode(productData.pubkey) +
              " as soon as they review your order.";
            await sendPaymentAndContactMessage(
              userPubkey!,
              receiptMessage,
              false,
              true,
              false,
              false,
              orderId
            );
          } else if (data.contact && data.contactType) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const contactMessage =
              "To finalize the sale of your " +
              productData.title +
              " listing" +
              productDetails +
              " on milk.market, please contact " +
              data.contact +
              " over " +
              data.contactType +
              " using the following instructions: " +
              data.contactInstructions;
            await sendPaymentAndContactMessage(
              productData.pubkey,
              contactMessage,
              false,
              false,
              false,
              false,
              orderId
            );

            await new Promise((resolve) => setTimeout(resolve, 500));
            const receiptMessage =
              "Your order for " +
              productData.title +
              productDetails +
              " was processed successfully! You should be receiving delivery information from " +
              nip19.npubEncode(productData.pubkey) +
              " as soon as they review your order.";
            await sendPaymentAndContactMessage(
              userPubkey!,
              receiptMessage,
              false,
              true,
              false,
              false,
              orderId
            );
          } else {
            await new Promise((resolve) => setTimeout(resolve, 500));
            const receiptMessage =
              "Thank you for your purchase of " +
              productData.title +
              productDetails +
              " from " +
              nip19.npubEncode(productData.pubkey) +
              ".";
            await sendPaymentAndContactMessage(
              userPubkey!,
              receiptMessage,
              false,
              true,
              false,
              false,
              orderId
            );
          }
        } else {
          pollCount++;
          if (pollCount < maxPolls) {
            setTimeout(checkStatus, 5000); // Poll every 5 seconds
          } else {
            setIsCheckingStripePayment(false);
            setFailureText(
              "Payment check timed out. Please verify your Stripe invoice."
            );
            setShowFailureModal(true);
          }
        }
      } catch (error) {
        console.error("Error checking Stripe payment status:", error);
        setIsCheckingStripePayment(false);
        setFailureText(
          "Failed to check payment status. Please check your Stripe invoice."
        );
        setShowFailureModal(true);
      }
    };

    checkStatus();
  };

  const renderContactForm = () => {
    if (!formType) return null;

    return (
      <div className="space-y-4">
        {formType === "contact" && (
          <>
            {productData.pickupLocations &&
              productData.pickupLocations.length > 0 && (
                <Controller
                  name="pickupLocation"
                  control={formControl}
                  rules={{ required: "A pickup location is required." }}
                  render={({
                    field: { onChange, onBlur, value },
                    fieldState: { error },
                  }) => (
                    <Select
                      variant="bordered"
                      fullWidth={true}
                      label={
                        <span className="text-light-text">
                          Pickup Location{" "}
                          <span className="text-red-500">*</span>
                        </span>
                      }
                      labelPlacement="inside"
                      placeholder="Select a pickup location"
                      isInvalid={!!error}
                      errorMessage={error?.message}
                      classNames={{
                        trigger:
                          "border-2 border-black rounded-md shadow-neo !bg-white",
                      }}
                      onChange={(e) => {
                        onChange(e);
                        setSelectedPickupLocation(e.target.value);
                      }}
                      isRequired={true}
                      onBlur={onBlur}
                      value={value || ""}
                    >
                      {productData.pickupLocations
                        ? productData.pickupLocations.map((location) => (
                            <SelectItem
                              key={location}
                              value={location}
                              className="text-dark-text"
                            >
                              {location}
                            </SelectItem>
                          ))
                        : []}
                    </Select>
                  )}
                />
              )}

            <Controller
              name="Contact"
              control={formControl}
              rules={{ required: "A contact is required." }}
              render={({
                field: { onChange, onBlur, value },
                fieldState: { error },
              }) => (
                <Input
                  variant="bordered"
                  fullWidth={true}
                  label={<span className="text-light-text">Contact</span>}
                  labelPlacement="inside"
                  placeholder="@milkmarket"
                  isInvalid={!!error}
                  errorMessage={error?.message}
                  classNames={{
                    inputWrapper: "border-2 border-black rounded-md shadow-neo",
                  }}
                  onChange={onChange}
                  isRequired={true}
                  onBlur={onBlur}
                  value={value || ""}
                />
              )}
            />

            <Controller
              name="Contact Type"
              control={formControl}
              rules={{ required: "A contact type is required." }}
              render={({
                field: { onChange, onBlur, value },
                fieldState: { error },
              }) => (
                <Input
                  variant="bordered"
                  fullWidth={true}
                  label={<span className="text-light-text">Contact type</span>}
                  labelPlacement="inside"
                  placeholder="Nostr, Signal, Telegram, email, phone, etc."
                  isInvalid={!!error}
                  errorMessage={error?.message}
                  classNames={{
                    inputWrapper: "border-2 border-black rounded-md shadow-neo",
                  }}
                  onChange={onChange}
                  isRequired={true}
                  onBlur={onBlur}
                  value={value || ""}
                />
              )}
            />

            <Controller
              name="Instructions"
              control={formControl}
              rules={{ required: "Delivery instructions are required." }}
              render={({
                field: { onChange, onBlur, value },
                fieldState: { error },
              }) => (
                <Textarea
                  variant="bordered"
                  fullWidth={true}
                  label={
                    <span className="text-light-text">
                      Delivery instructions
                    </span>
                  }
                  labelPlacement="inside"
                  placeholder="Meet me by . . .; Send file to . . ."
                  isInvalid={!!error}
                  errorMessage={error?.message}
                  classNames={{
                    inputWrapper: "border-2 border-black rounded-md shadow-neo",
                  }}
                  onChange={onChange}
                  isRequired={true}
                  onBlur={onBlur}
                  value={value || ""}
                />
              )}
            />
          </>
        )}

        {formType === "shipping" && (
          <>
            <Controller
              name="Name"
              control={formControl}
              rules={{
                required: "A name is required.",
                maxLength: {
                  value: 50,
                  message: "This input exceed maxLength of 50.",
                },
              }}
              render={({
                field: { onChange, onBlur, value },
                fieldState: { error },
              }) => (
                <Input
                  variant="bordered"
                  fullWidth={true}
                  label={<span className="text-light-text">Name</span>}
                  labelPlacement="inside"
                  isInvalid={!!error}
                  errorMessage={error?.message}
                  classNames={{
                    inputWrapper: "border-2 border-black rounded-md shadow-neo",
                  }}
                  onChange={onChange}
                  isRequired={true}
                  onBlur={onBlur}
                  value={value || ""}
                />
              )}
            />

            <Controller
              name="Address"
              control={formControl}
              rules={{
                required: "An address is required.",
                maxLength: {
                  value: 50,
                  message: "This input exceed maxLength of 50.",
                },
              }}
              render={({
                field: { onChange, onBlur, value },
                fieldState: { error },
              }) => (
                <Input
                  variant="bordered"
                  fullWidth={true}
                  label={<span className="text-light-text">Address</span>}
                  labelPlacement="inside"
                  isInvalid={!!error}
                  errorMessage={error?.message}
                  classNames={{
                    inputWrapper: "border-2 border-black rounded-md shadow-neo",
                  }}
                  onChange={onChange}
                  isRequired={true}
                  onBlur={onBlur}
                  value={value || ""}
                />
              )}
            />

            <Controller
              name="Unit"
              control={formControl}
              rules={{
                maxLength: {
                  value: 50,
                  message: "This input exceed maxLength of 50.",
                },
              }}
              render={({
                field: { onChange, onBlur, value },
                fieldState: { error },
              }) => (
                <Input
                  variant="bordered"
                  fullWidth={true}
                  label="Apt, suite, unit, etc."
                  labelPlacement="inside"
                  isInvalid={!!error}
                  errorMessage={error?.message}
                  classNames={{
                    inputWrapper: "border-2 border-black rounded-md shadow-neo",
                  }}
                  onChange={onChange}
                  onBlur={onBlur}
                  value={value || ""}
                />
              )}
            />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Controller
                name="City"
                control={formControl}
                rules={{
                  required: "A city is required.",
                  maxLength: {
                    value: 50,
                    message: "This input exceed maxLength of 50.",
                  },
                }}
                render={({
                  field: { onChange, onBlur, value },
                  fieldState: { error },
                }) => (
                  <Input
                    variant="bordered"
                    fullWidth={true}
                    label={<span className="text-light-text">City</span>}
                    labelPlacement="inside"
                    isInvalid={!!error}
                    errorMessage={error?.message}
                    classNames={{
                      inputWrapper:
                        "border-2 border-black rounded-md shadow-neo",
                    }}
                    onChange={onChange}
                    isRequired={true}
                    onBlur={onBlur}
                    value={value || ""}
                  />
                )}
              />

              <Controller
                name="State/Province"
                control={formControl}
                rules={{ required: "A state/province is required." }}
                render={({
                  field: { onChange, onBlur, value },
                  fieldState: { error },
                }) => (
                  <Input
                    variant="bordered"
                    fullWidth={true}
                    label={
                      <span className="text-light-text">State/Province</span>
                    }
                    labelPlacement="inside"
                    isInvalid={!!error}
                    errorMessage={error?.message}
                    classNames={{
                      inputWrapper:
                        "border-2 border-black rounded-md shadow-neo",
                    }}
                    onChange={onChange}
                    isRequired={true}
                    onBlur={onBlur}
                    value={value || ""}
                  />
                )}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Controller
                name="Postal Code"
                control={formControl}
                rules={{
                  required: "A postal code is required.",
                  maxLength: {
                    value: 50,
                    message: "This input exceed maxLength of 50.",
                  },
                }}
                render={({
                  field: { onChange, onBlur, value },
                  fieldState: { error },
                }) => (
                  <Input
                    variant="bordered"
                    fullWidth={true}
                    label={<span className="text-light-text">Postal code</span>}
                    labelPlacement="inside"
                    isInvalid={!!error}
                    errorMessage={error?.message}
                    classNames={{
                      inputWrapper:
                        "border-2 border-black rounded-md shadow-neo",
                    }}
                    onChange={onChange}
                    isRequired={true}
                    onBlur={onBlur}
                    value={value || ""}
                  />
                )}
              />

              <Controller
                name="Country"
                control={formControl}
                rules={{ required: "A country is required." }}
                render={({
                  field: { onChange, onBlur, value },
                  fieldState: { error },
                }) => (
                  <CountryDropdown
                    variant="bordered"
                    aria-label="Select Country"
                    label={<span className="text-light-text">Country</span>}
                    labelPlacement="inside"
                    isInvalid={!!error}
                    errorMessage={error?.message}
                    classNames={{
                      trigger:
                        "border-2 border-black rounded-md shadow-neo !bg-white",
                    }}
                    onChange={onChange}
                    isRequired={true}
                    onBlur={onBlur}
                    value={value || ""}
                  />
                )}
              />
            </div>
          </>
        )}

        {productData.required && productData.required !== "" && (
          <Controller
            name="Required"
            control={formControl}
            rules={{ required: "Additional information is required." }}
            render={({
              field: { onChange, onBlur, value },
              fieldState: { error },
            }) => (
              <Input
                variant="bordered"
                fullWidth={true}
                label={
                  <span className="text-light-text">
                    Enter {productData.required}
                  </span>
                }
                labelPlacement="inside"
                isInvalid={!!error}
                errorMessage={error?.message}
                classNames={{
                  inputWrapper: "border-2 border-black rounded-md shadow-neo",
                }}
                onChange={onChange}
                isRequired={true}
                onBlur={onBlur}
                value={value || ""}
              />
            )}
          />
        )}
      </div>
    );
  };

  if (showInvoiceCard) {
    return (
      <div className="flex min-h-screen w-full bg-white text-black">
        <div className="mx-auto flex w-full max-w-7xl flex-col lg:flex-row">
          {/* Left Side - Product Summary - maintain same width */}
          <div className="w-full bg-gray-50 p-6 lg:w-1/2">
            <div className="sticky top-6">
              <h2 className="mb-6 text-2xl font-bold">Order Summary</h2>

              <div className="mb-6">
                <Image
                  src={productData.images[0]}
                  alt={productData.title}
                  className="mb-4 h-32 w-32 rounded-lg object-cover"
                />

                <h3 className="mb-2 text-xl font-semibold">
                  {productData.title}
                </h3>

                {selectedSize && (
                  <p className="mb-1 text-gray-600">Size: {selectedSize}</p>
                )}

                {selectedVolume && (
                  <p className="mb-1 text-gray-600">Volume: {selectedVolume}</p>
                )}
                {selectedWeight && (
                  <p className="mb-1 text-gray-600">Weight: {selectedWeight}</p>
                )}

                <p className="mb-1 text-gray-600">Quantity: 1</p>
              </div>

              <div className="border-t pt-4">
                <div className="space-y-3">
                  <h4 className="font-semibold text-gray-700">
                    Cost Breakdown
                  </h4>
                  <div className="space-y-2 border-l-2 border-gray-200 pl-3">
                    <div className="text-sm font-medium">
                      {productData.title}
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="ml-2">Product cost:</span>
                      <span>
                        {formatWithCommas(
                          productData.volumePrice !== undefined
                            ? productData.volumePrice
                            : productData.weightPrice !== undefined
                              ? productData.weightPrice
                              : productData.price,
                          productData.currency
                        )}
                      </span>
                    </div>
                    {productData.shippingCost! > 0 &&
                      formType === "shipping" && (
                        <div className="flex justify-between text-sm">
                          <span className="ml-2">Shipping cost:</span>
                          <span>
                            {formatWithCommas(
                              productData.shippingCost!,
                              productData.currency
                            )}
                          </span>
                        </div>
                      )}
                  </div>
                  <div className="flex justify-between border-t pt-2 font-semibold">
                    <span>Total:</span>
                    <span>
                      {formatWithCommas(
                        formType === "shipping"
                          ? productData.totalCost
                          : productData.price,
                        productData.currency
                      )}
                    </span>
                  </div>
                </div>
              </div>

              <button
                onClick={() => setIsBeingPaid(false)}
                className="mt-4 text-black underline hover:text-gray-600"
              >
                ← Back to product
              </button>
            </div>
          </div>

          {/* Divider */}
          <div className="h-px w-full bg-gray-300 lg:h-full lg:w-px"></div>

          {/* Right Side - Lightning Invoice - maintain consistent width */}
          <div className="w-full p-6 lg:w-1/2">
            <div className="w-full">
              <div className="mb-6">
                <h2 className="text-2xl font-bold">
                  {stripeInvoiceUrl ? "Stripe Payment" : "Lightning Invoice"}
                </h2>
              </div>
              <div className="flex flex-col items-center">
                {!paymentConfirmed && !stripePaymentConfirmed ? (
                  <div className="flex flex-col items-center justify-center">
                    {qrCodeUrl && (
                      <>
                        <h3 className="text-dark-text mt-3 text-center text-lg font-medium leading-6">
                          Don&apos;t refresh or close the page until the payment
                          has been confirmed!
                        </h3>
                        <Image
                          alt="Lightning invoice"
                          className="object-cover"
                          src={qrCodeUrl}
                        />
                        <div className="flex items-center justify-center">
                          <p className="text-center">
                            {invoice.length > 30
                              ? `${invoice.substring(
                                  0,
                                  10
                                )}...${invoice.substring(
                                  invoice.length - 10,
                                  invoice.length
                                )}`
                              : invoice}
                          </p>
                          <ClipboardIcon
                            onClick={handleCopyInvoice}
                            className={`text-dark-text ml-2 h-4 w-4 cursor-pointer ${
                              copiedToClipboard ? "hidden" : ""
                            }`}
                          />
                          <CheckIcon
                            className={`text-dark-text ml-2 h-4 w-4 cursor-pointer ${
                              copiedToClipboard ? "" : "hidden"
                            }`}
                          />
                        </div>
                      </>
                    )}
                    {stripeInvoiceUrl && (
                      <>
                        <h3 className="text-dark-text mt-3 text-center text-lg font-medium leading-6">
                          Please complete your payment via Stripe.
                        </h3>
                        <a
                          href={stripeInvoiceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-4 rounded-md bg-blue-500 px-6 py-3 text-white no-underline hover:bg-blue-600"
                        >
                          Proceed to Stripe
                        </a>
                        {isCheckingStripePayment && (
                          <div className="mt-4 text-center">
                            <p>Checking payment status...</p>
                            <p className="mt-2 text-sm text-gray-600">
                              Time remaining:{" "}
                              {Math.floor(stripeTimeoutSeconds / 60)}:
                              {(stripeTimeoutSeconds % 60)
                                .toString()
                                .padStart(2, "0")}
                            </p>
                          </div>
                        )}
                        <button
                          onClick={() => {
                            setShowInvoiceCard(false);
                            setStripeInvoiceUrl(null);
                            setStripeInvoiceId(null);
                            setIsCheckingStripePayment(false);
                            setHasTimedOut(false);
                          }}
                          className="mt-4 text-sm text-gray-600 underline hover:text-gray-800"
                        >
                          Cancel and return to checkout
                        </button>
                      </>
                    )}
                    {!qrCodeUrl && !stripeInvoiceUrl && (
                      <div>
                        <p>Waiting for payment invoice...</p>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center justify-center">
                    <h3 className="text-dark-text mt-3 text-center text-lg font-medium leading-6">
                      Payment confirmed!
                    </h3>
                    <Image
                      alt="Payment Confirmed"
                      className="object-cover"
                      src="../payment-confirmed.gif"
                      width={350}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full bg-white text-black">
      <div className="mx-auto flex w-full max-w-7xl flex-col lg:flex-row">
        {/* Left Side - Product Summary */}
        <div className="w-full bg-gray-50 p-6 lg:w-1/2">
          <div className="sticky top-6">
            <h2 className="mb-6 text-2xl font-bold">Order Summary</h2>

            <div className="mb-6">
              <Image
                src={productData.images[0]}
                alt={productData.title}
                className="mb-4 h-32 w-32 rounded-lg object-cover"
              />

              <h3 className="mb-2 text-xl font-semibold">
                {productData.title}
              </h3>

              {selectedSize && (
                <p className="mb-1 text-gray-600">Size: {selectedSize}</p>
              )}

              {selectedVolume && (
                <p className="mb-1 text-gray-600">Volume: {selectedVolume}</p>
              )}
              {selectedWeight && (
                <p className="mb-1 text-gray-600">Weight: {selectedWeight}</p>
              )}

              <p className="mb-1 text-gray-600">Quantity: 1</p>
            </div>

            <div className="border-t pt-4">
              <div className="space-y-3">
                <h4 className="font-semibold text-gray-700">Cost Breakdown</h4>
                <div className="space-y-2 border-l-2 border-gray-200 pl-3">
                  <div className="text-sm font-medium">{productData.title}</div>
                  {discountPercentage && discountPercentage > 0 ? (
                    <>
                      <div className="flex justify-between text-sm">
                        <span className="ml-2">Product cost:</span>
                        <span className="text-gray-500 line-through">
                          {formatWithCommas(
                            originalPrice || productData.price,
                            productData.currency
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm text-green-600">
                        <span className="ml-2">
                          {discountCode || "Discount"} ({discountPercentage}%):
                        </span>
                        <span>
                          -
                          {formatWithCommas(
                            ((originalPrice || productData.price) *
                              discountPercentage) /
                              100,
                            productData.currency
                          )}
                        </span>
                      </div>
                      <div className="flex justify-between text-sm font-medium">
                        <span className="ml-2">Discounted price:</span>
                        <span>
                          {formatWithCommas(
                            productData.price,
                            productData.currency
                          )}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="flex justify-between text-sm">
                      <span className="ml-2">Product cost:</span>
                      <span>
                        {formatWithCommas(
                          productData.price,
                          productData.currency
                        )}
                      </span>
                    </div>
                  )}
                  {productData.shippingCost! > 0 && formType === "shipping" && (
                    <div className="flex justify-between text-sm">
                      <span className="ml-2">Shipping cost:</span>
                      <span>
                        {formatWithCommas(
                          productData.shippingCost!,
                          productData.currency
                        )}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex justify-between border-t pt-2 font-semibold">
                  <span>Total:</span>
                  <span>
                    {formatWithCommas(
                      formType === "shipping"
                        ? productData.totalCost
                        : productData.price,
                      productData.currency
                    )}
                  </span>
                </div>
              </div>
            </div>

            <button
              onClick={() => setIsBeingPaid(false)}
              className="mt-4 text-black underline hover:text-gray-600"
            >
              ← Back to product
            </button>
          </div>
        </div>

        {/* Divider */}
        <div className="h-px w-full bg-gray-300 lg:h-full lg:w-px"></div>

        {/* Right Side - Order Type Selection, Forms, and Payment */}
        <div className="w-full p-6 lg:w-1/2">
          {/* Order Type Selection */}
          {showOrderTypeSelection && (
            <>
              <h2 className="mb-6 text-2xl font-bold">Select Order Type</h2>
              <div className="space-y-3">
                {productData.shippingType === "Free/Pickup" ||
                productData.shippingType === "Added Cost/Pickup" ? (
                  <>
                    <button
                      onClick={() => handleOrderTypeSelection("shipping")}
                      className="w-full rounded-md border-2 border-black bg-white p-4 text-left shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
                    >
                      <div className="font-medium">Free or added shipping</div>
                      <div className="text-sm text-gray-500">
                        Get it shipped to your address
                      </div>
                    </button>
                    <button
                      onClick={() => handleOrderTypeSelection("contact")}
                      className="w-full rounded-md border-2 border-black bg-white p-4 text-left shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
                    >
                      <div className="font-medium">Pickup</div>
                      <div className="text-sm text-gray-500">
                        Arrange pickup with seller
                      </div>
                    </button>
                  </>
                ) : productData.shippingType === "Free" ||
                  productData.shippingType === "Added Cost" ? (
                  <button
                    onClick={() => handleOrderTypeSelection("shipping")}
                    className="w-full rounded-md border-2 border-black bg-white p-4 text-left shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
                  >
                    <div className="font-medium">
                      Online order with shipping
                    </div>
                    <div className="text-sm text-gray-500">
                      Get it shipped to your address
                    </div>
                  </button>
                ) : (
                  <button
                    onClick={() => handleOrderTypeSelection("contact")}
                    className="w-full rounded-md border-2 border-black bg-white p-4 text-left shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
                  >
                    <div className="font-medium">Online order</div>
                    <div className="text-sm text-gray-500">
                      Digital or pickup delivery
                    </div>
                  </button>
                )}
              </div>
            </>
          )}

          {/* Contact/Shipping Form */}
          {formType && (
            <>
              <h2 className="mb-6 text-2xl font-bold">
                {formType === "shipping" && "Shipping Information"}
                {formType === "contact" && "Contact Information"}
              </h2>

              <form
                onSubmit={handleFormSubmit((data) => onFormSubmit(data))}
                className="space-y-6"
              >
                {renderContactForm()}

                <div className="mt-6 space-y-3 border-t pt-6">
                  <h3 className="mb-4 text-xl font-bold">Payment Method</h3>

                  <Button
                    className={`w-full rounded-md border-2 border-black bg-primary-blue px-4 py-2 font-bold text-white shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                      !isFormValid ? "cursor-not-allowed opacity-50" : ""
                    }`}
                    disabled={!isFormValid}
                    onClick={() => {
                      if (!isLoggedIn) {
                        onOpen();
                        return;
                      }
                      handleFormSubmit((data) =>
                        onFormSubmit(data, "lightning")
                      )();
                    }}
                    startContent={<BoltIcon className="h-6 w-6" />}
                  >
                    Pay with Lightning: {formattedTotalCost}
                  </Button>

                  {hasTokensAvailable && (
                    <Button
                      className={`w-full rounded-md border-2 border-black bg-black px-4 py-2 font-bold text-white shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                        !isFormValid ? "cursor-not-allowed opacity-50" : ""
                      }`}
                      disabled={!isFormValid}
                      onClick={() => {
                        if (!isLoggedIn) {
                          onOpen();
                          return;
                        }
                        handleFormSubmit((data) =>
                          onFormSubmit(data, "cashu")
                        )();
                      }}
                      startContent={<BanknotesIcon className="h-6 w-6" />}
                    >
                      Pay with Cashu: {formattedTotalCost}
                    </Button>
                  )}

                  {/* Stripe Payment Button */}
                  {isStripeMerchant && (
                    <Button
                      className={`w-full rounded-md border-2 border-black bg-black px-4 py-2 font-bold text-white shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                        !isFormValid ? "cursor-not-allowed opacity-50" : ""
                      }`}
                      disabled={!isFormValid}
                      onClick={() => {
                        if (!isLoggedIn) {
                          onOpen();
                          return;
                        }
                        handleFormSubmit((data) =>
                          onFormSubmit(data, "stripe")
                        )();
                      }}
                      startContent={<CurrencyDollarIcon className="h-6 w-6" />}
                    >
                      Pay with Card: {formattedTotalCost}
                    </Button>
                  )}

                  {Object.keys(fiatPaymentOptions).length > 0 && (
                    <Button
                      className={`w-full rounded-md border-2 border-black bg-black px-4 py-2 font-bold text-white shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                        !isFormValid ? "cursor-not-allowed opacity-50" : ""
                      }`}
                      disabled={!isFormValid}
                      onClick={() => {
                        if (!isLoggedIn) {
                          onOpen();
                          return;
                        }
                        handleFormSubmit((data) =>
                          onFormSubmit(data, "fiat")
                        )();
                      }}
                      startContent={<CurrencyDollarIcon className="h-6 w-6" />}
                    >
                      Pay with Cash or Payment App: {formattedTotalCost}
                    </Button>
                  )}

                  {/* NWC Button */}
                  {nwcInfo && (
                    <Button
                      className={`w-full rounded-md border-2 border-black bg-black px-4 py-2 font-bold text-white shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                        !isFormValid ? "cursor-not-allowed opacity-50" : ""
                      }`}
                      disabled={!isFormValid || isNwcLoading}
                      isLoading={isNwcLoading}
                      onClick={() => {
                        if (!isLoggedIn) {
                          onOpen();
                          return;
                        }
                        // We must call handleFormSubmit to get the validated form data
                        handleFormSubmit((data) =>
                          // Then pass that data to our new NWC payment handler
                          onFormSubmit(data, "nwc")
                        )();
                      }}
                      startContent={<WalletIcon className="h-6 w-6" />}
                    >
                      Pay with {nwcInfo.alias || "NWC"}: {formattedTotalCost}
                    </Button>
                  )}
                </div>
              </form>
            </>
          )}

          {/* Order Confirmed Display */}
          {orderConfirmed && (
            <div className="flex flex-col items-center justify-center">
              <h3 className="mt-3 text-center text-lg font-medium leading-6 text-gray-900">
                Order confirmed!
              </h3>
              <Image
                alt="Payment Confirmed"
                className="object-cover"
                src="../payment-confirmed.gif"
                width={350}
              />
            </div>
          )}
        </div>
      </div>

      {/* Fiat Payment Instructions */}
      {showFiatPaymentInstructions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
          <div className="max-w-md rounded-lg bg-gray-800 p-8 text-center">
            {selectedFiatOption === "cash" ? (
              <>
                <h3 className="mb-4 text-2xl font-bold text-white">
                  Cash Payment
                </h3>
                <p className="mb-6 text-gray-400">
                  You will need{" "}
                  {formatWithCommas(
                    formType === "shipping"
                      ? productData.totalCost
                      : productData.price,
                    productData.currency
                  )}{" "}
                  in cash for this order.
                </p>
                <div className="mb-6 flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="paymentConfirmed"
                    checked={fiatPaymentConfirmed}
                    onChange={(e) => setFiatPaymentConfirmed(e.target.checked)}
                    className="text-light-text focus:ring-accent-light-text h-4 w-4 rounded border-gray-300"
                  />
                  <label
                    htmlFor="paymentConfirmed"
                    className="text-left text-gray-300"
                  >
                    I will have the sufficient cash to complete the order upon
                    pickup or delivery
                  </label>
                </div>
              </>
            ) : (
              <>
                <h3 className="mb-4 text-2xl font-bold text-white">
                  Send Payment
                </h3>
                <p className="mb-4 text-gray-400">
                  Please send{" "}
                  {formatWithCommas(
                    formType === "shipping"
                      ? productData.totalCost
                      : productData.price,
                    productData.currency
                  )}{" "}
                  to:
                </p>
                <div className="mb-6 rounded-lg bg-gray-100 p-4">
                  <p className="font-semibold text-gray-900">
                    {selectedFiatOption}:{" "}
                    {profileContext.profileData.get(productData.pubkey)?.content
                      ?.fiat_options?.[selectedFiatOption] || "N/A"}
                  </p>
                </div>
                <div className="mb-6 flex items-center space-x-2">
                  <input
                    type="checkbox"
                    id="paymentConfirmed"
                    checked={fiatPaymentConfirmed}
                    onChange={(e) => setFiatPaymentConfirmed(e.target.checked)}
                    className="text-light-text focus:ring-accent-light-text h-4 w-4 rounded border-gray-300"
                  />
                  <label htmlFor="paymentConfirmed" className="text-gray-300">
                    I have sent the payment
                  </label>
                </div>
              </>
            )}
            <div className="space-y-2">
              <Button
                onClick={async () => {
                  if (fiatPaymentConfirmed) {
                    setShowFiatPaymentInstructions(false);
                    await handleFiatPayment(
                      formType === "shipping"
                        ? productData.totalCost
                        : productData.price,
                      pendingPaymentData || {}
                    );
                    setPendingPaymentData(null); // Clear stored data
                  }
                }}
                disabled={!fiatPaymentConfirmed}
                className={`w-full rounded-md border-2 border-black bg-black px-4 py-2 font-bold text-white shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5 ${
                  !fiatPaymentConfirmed ? "cursor-not-allowed opacity-50" : ""
                }`}
              >
                {selectedFiatOption === "cash"
                  ? "Confirm Order"
                  : "Confirm Payment Sent"}
              </Button>
              <Button
                onClick={() => {
                  setShowFiatPaymentInstructions(false);
                  setFiatPaymentConfirmed(false);
                  setSelectedFiatOption("");
                  setPendingPaymentData(null); // Clear stored data
                }}
                className="w-full rounded-md border-2 border-black bg-white px-4 py-2 font-bold text-black shadow-neo transition-transform hover:-translate-y-0.5 active:translate-y-0.5"
              >
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Modals */}
      <Modal
        backdrop="blur"
        isOpen={showFiatTypeOption}
        onClose={() => setShowFiatTypeOption(false)}
        classNames={{
          body: "py-6 bg-dark-fg",
          backdrop: "bg-[#292f46]/50 backdrop-opacity-60",
          header: "border-b-[1px] border-[#292f46] bg-dark-fg rounded-t-lg",
          footer: "border-t-[1px] border-[#292f46] bg-dark-fg rounded-b-lg",
          closeButton: "hover:bg-black/5 active:bg-white/10",
        }}
        isDismissable={true}
        scrollBehavior={"normal"}
        placement={"center"}
        size="2xl"
      >
        <ModalContent>
          <ModalHeader className="text-dark-text flex items-center justify-center">
            Select your fiat payment preference:
          </ModalHeader>
          <ModalBody className="flex flex-col overflow-hidden">
            <div className="flex items-center justify-center">
              <Select
                label="Fiat Payment Options"
                className="max-w-xs"
                onChange={(e) => {
                  setSelectedFiatOption(e.target.value);
                  setShowFiatTypeOption(false);
                  // Show payment instructions
                  setShowFiatPaymentInstructions(true);
                }}
              >
                {fiatPaymentOptions &&
                  Object.keys(fiatPaymentOptions).map((option) => (
                    <SelectItem
                      key={option}
                      value={option}
                      className="text-dark-text"
                    >
                      {option}
                    </SelectItem>
                  ))}
              </Select>
            </div>
          </ModalBody>
        </ModalContent>
      </Modal>

      <SignInModal isOpen={isOpen} onClose={onClose} />

      <FailureModal
        bodyText={failureText}
        isOpen={showFailureModal}
        onClose={() => {
          setShowFailureModal(false);
          setFailureText("");
        }}
      />

      {/* Stripe Timeout Modal */}
      <FailureModal
        bodyText="The payment window has timed out. Please try again if you'd like to complete your purchase."
        isOpen={hasTimedOut}
        onClose={() => {
          setHasTimedOut(false);
          setStripeTimeoutSeconds(STRIPE_TIMEOUT_SECONDS);
        }}
      />
    </div>
  );
}
