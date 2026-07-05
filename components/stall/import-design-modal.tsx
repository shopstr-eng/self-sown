"use client";

import { useContext, useState } from "react";
import router from "next/router";
import {
  Modal,
  ModalContent,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Input,
  Spinner,
} from "@heroui/react";
import {
  GlobeAltIcon,
  ExclamationTriangleIcon,
  SparklesIcon,
  ArrowPathIcon,
} from "@heroicons/react/24/outline";
import {
  BLUEBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import { SignerContext } from "@/components/utility-components/nostr-context-provider";
import { createSellerActionAuthEventTemplate } from "@milk-market/nostr";
import {
  IMPORT_DESIGN_DRAFT_KEY,
  type ImportedStoreDesign,
  type ImportedProductPage,
} from "@/utils/migrations/site-design";
import {
  rehostStorefrontDesignImages,
  rehostProductPageImages,
} from "@/utils/migrations/rehost-storefront-images";
import type { StorefrontColorScheme } from "@/utils/types/types";
import StorefrontPreviewPanel, {
  sampleProductsToPreview,
} from "@/components/settings/storefront/storefront-preview-panel";
import StorefrontPreviewFrame from "@/components/storefront/storefront-preview-frame";
import SectionRenderer from "@/components/storefront/section-renderer";
import { PLACEHOLDER_PRODUCT } from "@/utils/storefront/placeholder-product";
import { useProMembership } from "@/components/utility-components/pro-membership-context";
import UpgradeBanner from "@/components/pro/upgrade-banner";

// Colors/fonts used to render the product-page preview so it matches the
// seller's actual stall theme (the imported page adopts the shop theme, not the
// source site's colors).
export interface ProductImportPreviewContext {
  colors: StorefrontColorScheme;
  shopName?: string;
  shopPicture?: string;
  fontHeading?: string;
  fontBody?: string;
  customFontHeadingUrl?: string;
  customFontHeadingName?: string;
  customFontBodyUrl?: string;
  customFontBodyName?: string;
}

interface ImportDesignModalProps {
  isOpen: boolean;
  onClose: () => void;
  // "stall" (default) imports a full landing/stall design and hands off to the
  // storefront editor. "product" imports product-page sections and hands them
  // back via onApplyProduct (no route hop).
  mode?: "stall" | "product";
  onApplyProduct?: (design: ImportedProductPage) => void;
  productPreview?: ProductImportPreviewContext;
  shopPubkey?: string;
}

type Step = "url" | "generating" | "preview";

const API_PATH = "/api/storefront/import-from-url";

const FALLBACK_COLORS: StorefrontColorScheme = {
  primary: "#111111",
  secondary: "#444444",
  accent: "#f6c026",
  background: "#ffffff",
  text: "#1a1a1a",
};

const INPUT_CLASSNAMES = {
  input: "bg-white !text-black placeholder:!text-gray-500",
  inputWrapper:
    "bg-white border-2 border-black rounded-md data-[hover=true]:bg-white group-data-[focus=true]:border-primary-yellow",
  label: "text-black font-bold",
};

function isProductDesign(
  d: ImportedStoreDesign | ImportedProductPage
): d is ImportedProductPage {
  return !("storefront" in d);
}

export default function ImportDesignModal({
  isOpen,
  onClose,
  mode = "stall",
  onApplyProduct,
  productPreview,
  shopPubkey,
}: ImportDesignModalProps) {
  const { signer, isLoggedIn, pubkey } = useContext(SignerContext);
  const { isPro, loading: proLoading } = useProMembership();

  const isProductMode = mode === "product";

  const [step, setStep] = useState<Step>("url");
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [design, setDesign] = useState<
    ImportedStoreDesign | ImportedProductPage | null
  >(null);
  const [isLoading, setIsLoading] = useState(false);

  const resetAndClose = () => {
    setStep("url");
    setUrl("");
    setError(null);
    setDesign(null);
    setIsLoading(false);
    onClose();
  };

  const normalizeInputUrl = (raw: string): string | null => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withScheme = /^https?:\/\//i.test(trimmed)
      ? trimmed
      : `https://${trimmed}`;
    try {
      const u = new URL(withScheme);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.toString();
    } catch {
      return null;
    }
  };

  const handleGenerate = async () => {
    setError(null);
    if (proLoading || !isPro) return;
    if (!signer?.sign || !isLoggedIn || !pubkey) {
      setError("Please sign in first.");
      return;
    }
    const cleanUrl = normalizeInputUrl(url);
    if (!cleanUrl) {
      setError("Enter a valid website address, like yourshop.com");
      return;
    }

    setStep("generating");
    setIsLoading(true);
    try {
      // Product imports bind `mode` into the signed fields; stall imports sign
      // just { url } so existing signatures stay byte-identical.
      const fields = isProductMode
        ? { url: cleanUrl, mode: "product" }
        : { url: cleanUrl };
      const signedEvent = await signer.sign(
        createSellerActionAuthEventTemplate(pubkey, "storefront-import-write", {
          method: "POST",
          path: API_PATH,
          fields,
        })
      );

      const res = await fetch(API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          pubkey,
          url: cleanUrl,
          signedEvent,
          ...(isProductMode ? { mode: "product" } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't build a design from that website.");
        setStep("url");
        return;
      }
      setDesign(data.design as ImportedStoreDesign | ImportedProductPage);
      setStep("preview");
    } catch (err) {
      console.error("Import design failed:", err);
      setError("Something went wrong. Please try again.");
      setStep("url");
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadIntoEditor = async () => {
    if (!design || isProductDesign(design)) return;
    const stallDesign = design;
    setIsLoading(true);
    setError(null);
    let finalDesign = stallDesign;
    try {
      if (signer) {
        const { design: rehosted } = await rehostStorefrontDesignImages(
          stallDesign,
          signer
        );
        finalDesign = rehosted;
      }
    } catch (err) {
      // Rehost is best-effort; keep going with the original image URLs.
      console.error("Storefront image rehost failed:", err);
    }

    try {
      localStorage.setItem(
        IMPORT_DESIGN_DRAFT_KEY,
        JSON.stringify(finalDesign)
      );
    } catch (err) {
      console.error("Failed to stash imported design:", err);
      setError("Couldn't save the draft in your browser. Please try again.");
      setIsLoading(false);
      return;
    }

    resetAndClose();
    router.push("/settings/stall?tab=storefront&importDraft=1");
  };

  const handleApplyProduct = async () => {
    if (!design || !isProductDesign(design)) return;
    const productDesign = design;
    setIsLoading(true);
    setError(null);
    let finalDesign = productDesign;
    try {
      if (signer) {
        const { design: rehosted } = await rehostProductPageImages(
          productDesign,
          signer
        );
        finalDesign = rehosted;
      }
    } catch (err) {
      // Rehost is best-effort; keep the original image URLs.
      console.error("Product image rehost failed:", err);
    }
    onApplyProduct?.(finalDesign);
    resetAndClose();
  };

  const stallColors =
    design && !isProductDesign(design)
      ? design.storefront.colorScheme
      : undefined;
  const previewColors =
    stallColors ?? productPreview?.colors ?? FALLBACK_COLORS;

  const headerText = isProductMode
    ? "Import product page from a website"
    : "Import stall design from a website";

  return (
    <Modal
      isOpen={isOpen}
      onClose={resetAndClose}
      size="4xl"
      scrollBehavior="inside"
      classNames={{
        base: "bg-white border-4 border-black rounded-lg",
        header: "border-b-2 border-black",
        footer: "border-t-2 border-black",
      }}
    >
      <ModalContent>
        <ModalHeader className="flex items-center gap-2 text-black">
          <GlobeAltIcon className="h-6 w-6" />
          {headerText}
        </ModalHeader>

        <ModalBody className="text-black">
          {error && (
            <div className="flex items-start gap-2 rounded-md border-2 border-red-500 bg-red-50 p-3 text-sm text-red-700">
              <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {step === "url" && (
            <div className="flex flex-col gap-4 py-2">
              <p className="text-sm text-gray-700">
                {isProductMode
                  ? "Paste the address of a product page from your existing shop (Shopify, WooCommerce, or any website). We'll pull in its photos and description and turn them into product-page sections you can preview and tweak before saving."
                  : "Paste the address of your existing shop (Shopify, WooCommerce, Barn2Door, or any website). We'll pull in your colors, fonts, logo, and text, then use AI to shape a matching stall design you can preview and tweak before saving."}
              </p>
              {!proLoading && !isPro ? (
                <UpgradeBanner
                  feature={
                    isProductMode
                      ? "Importing a product page from a website"
                      : "Importing a design from a website"
                  }
                />
              ) : (
                <>
                  <Input
                    label="Website address"
                    placeholder={
                      isProductMode
                        ? "yourshop.com/products/raw-milk"
                        : "yourshop.com"
                    }
                    value={url}
                    onValueChange={setUrl}
                    variant="bordered"
                    classNames={INPUT_CLASSNAMES}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleGenerate();
                    }}
                  />
                  <p className="text-xs text-gray-500">
                    Nothing is published. This only creates a draft you can
                    edit.
                  </p>
                </>
              )}
            </div>
          )}

          {step === "generating" && (
            <div className="flex flex-col items-center justify-center gap-4 py-12 text-center">
              <Spinner size="lg" />
              <div>
                <p className="flex items-center justify-center gap-2 font-bold">
                  <SparklesIcon className="h-5 w-5" />
                  {isProductMode
                    ? "Building your product page…"
                    : "Building your stall design…"}
                </p>
                <p className="mt-1 text-sm text-gray-600">
                  Reading your site and composing a matching look. This can take
                  a few seconds.
                </p>
              </div>
            </div>
          )}

          {step === "preview" && design && (
            <div className="flex flex-col gap-4 py-2">
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-700">
                  Here&apos;s a draft based on{" "}
                  <span className="font-bold">{design.sourceUrl}</span>.{" "}
                  {isProductMode
                    ? "Add it to your product page to fine-tune and save."
                    : "Load it into the editor to fine-tune and save."}
                </p>
                {!isProductDesign(design) && design.aiApplied && (
                  <span className="bg-primary-yellow flex items-center gap-1 rounded-full border-2 border-black px-2 py-0.5 text-xs font-bold whitespace-nowrap">
                    <SparklesIcon className="h-3.5 w-3.5" />
                    AI styled
                  </span>
                )}
              </div>

              {design.warnings.length > 0 && (
                <div className="rounded-md border-2 border-yellow-500 bg-yellow-50 p-3 text-xs text-yellow-800">
                  <ul className="list-inside list-disc space-y-1">
                    {design.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </div>
              )}

              <div className="overflow-hidden rounded-lg border-2 border-black">
                {isProductDesign(design) ? (
                  design.sections.length === 0 ? (
                    <div className="bg-white p-6 text-center text-sm text-gray-600">
                      We couldn&apos;t find product content on that page. Try a
                      direct product URL.
                    </div>
                  ) : (
                    <StorefrontPreviewFrame
                      colors={previewColors}
                      fontHeading={productPreview?.fontHeading}
                      fontBody={productPreview?.fontBody}
                      customFontHeadingUrl={
                        productPreview?.customFontHeadingUrl
                      }
                      customFontHeadingName={
                        productPreview?.customFontHeadingName
                      }
                      customFontBodyUrl={productPreview?.customFontBodyUrl}
                      customFontBodyName={productPreview?.customFontBodyName}
                    >
                      {design.sections.map((s) => (
                        <SectionRenderer
                          key={s.id}
                          section={s}
                          colors={previewColors}
                          shopName={
                            productPreview?.shopName || design.name || "Stall"
                          }
                          shopPicture={productPreview?.shopPicture || ""}
                          shopPubkey={shopPubkey || ""}
                          products={[]}
                          currentProduct={PLACEHOLDER_PRODUCT}
                        />
                      ))}
                    </StorefrontPreviewFrame>
                  )
                ) : (
                  <StorefrontPreviewPanel
                    shopName={design.name || "Your Shop"}
                    shopAbout={design.about || ""}
                    pictureUrl={design.logoUrl || ""}
                    bannerUrl={design.bannerUrl || ""}
                    colors={previewColors}
                    productLayout="grid"
                    landingPageStyle={
                      design.storefront.landingPageStyle || "hero"
                    }
                    fontHeading={design.storefront.fontHeading || ""}
                    fontBody={design.storefront.fontBody || ""}
                    sections={design.storefront.sections || []}
                    pages={[]}
                    footer={design.storefront.footer || {}}
                    navLinks={[]}
                    navLayout={design.storefront.navLayout}
                    realProducts={sampleProductsToPreview(
                      design.sampleProducts
                    )}
                    navColors={design.storefront.navColors}
                    footerColors={design.storefront.footerColors}
                    shopSlug="preview"
                    compact
                  />
                )}
              </div>
            </div>
          )}
        </ModalBody>

        <ModalFooter>
          {step === "url" && (
            <>
              <Button className={WHITEBUTTONCLASSNAMES} onClick={resetAndClose}>
                Cancel
              </Button>
              <Button
                className={BLUEBUTTONCLASSNAMES}
                onClick={handleGenerate}
                isDisabled={isLoading || proLoading || !isPro}
                startContent={<SparklesIcon className="h-4 w-4" />}
              >
                {isProductMode ? "Build product page" : "Build my design"}
              </Button>
            </>
          )}
          {step === "preview" && design && (
            <>
              <Button
                className={WHITEBUTTONCLASSNAMES}
                onClick={() => {
                  setStep("url");
                  setDesign(null);
                }}
                startContent={<ArrowPathIcon className="h-4 w-4" />}
              >
                Try another URL
              </Button>
              <Button
                className={BLUEBUTTONCLASSNAMES}
                onClick={
                  isProductMode ? handleApplyProduct : handleLoadIntoEditor
                }
                isDisabled={isLoading}
              >
                {isLoading
                  ? isProductMode
                    ? "Adding…"
                    : "Loading…"
                  : isProductMode
                    ? "Add to product page"
                    : "Load into editor"}
              </Button>
            </>
          )}
        </ModalFooter>
      </ModalContent>
    </Modal>
  );
}
