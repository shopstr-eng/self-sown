import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { Button, Input, Spinner } from "@heroui/react";
import {
  GlobeAltIcon,
  SparklesIcon,
  ExclamationTriangleIcon,
  ArrowPathIcon,
  ArrowLongRightIcon,
  CheckCircleIcon,
} from "@heroicons/react/24/outline";
import {
  BLUEBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  IMPORT_DESIGN_DRAFT_KEY,
  type ImportedStoreDesign,
} from "@/utils/migrations/site-design";
import type { StorefrontColorScheme } from "@/utils/types/types";
import StorefrontPreviewPanel from "@/components/settings/storefront/storefront-preview-panel";

const API_PATH = "/api/storefront/preview-from-url";

const FALLBACK_COLORS: StorefrontColorScheme = {
  primary: "#111111",
  secondary: "#444444",
  accent: "#f6c026",
  background: "#ffffff",
  text: "#1a1a1a",
};

const INPUT_CLASSNAMES = {
  input: "bg-white !text-black placeholder:!text-gray-500 text-base",
  inputWrapper:
    "bg-white border-2 border-black rounded-md h-14 data-[hover=true]:bg-white group-data-[focus=true]:border-primary-yellow",
};

function normalizeInputUrl(raw: string): string | null {
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
}

const VALUE_PROPS = [
  {
    title: "Paste your URL",
    body: "Shopify, WooCommerce, Barn2Door, or any website.",
  },
  {
    title: "See it instantly",
    body: "We match your colors, fonts, logo, and words automatically.",
  },
  {
    title: "Claim & go live",
    body: "Create your stall with the design pre-loaded, ready to save.",
  },
];

export default function ConvertPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [design, setDesign] = useState<ImportedStoreDesign | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);
  const autoRanRef = useRef(false);

  const runPreview = useCallback(async (rawUrl: string) => {
    const clean = normalizeInputUrl(rawUrl);
    if (!clean) {
      setError("Enter a valid website address, like yourshop.com");
      return;
    }
    setError(null);
    setLoading(true);
    setDesign(null);
    try {
      const res = await fetch(API_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: clean }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Couldn't build a design from that website.");
        return;
      }
      setDesign(data.design as ImportedStoreDesign);
    } catch (err) {
      console.error("Preview failed:", err);
      setError("Something went wrong. Please try again.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Auto-run from a shareable ?url= link (the founder outreach case).
  useEffect(() => {
    if (!router.isReady || autoRanRef.current) return;
    const q = router.query.url;
    const initial = Array.isArray(q) ? q[0] : q;
    if (initial) {
      autoRanRef.current = true;
      setUrl(initial);
      runPreview(initial);
    }
  }, [router.isReady, router.query.url, runPreview]);

  const handleClaim = () => {
    if (!design) return;
    setClaiming(true);
    try {
      localStorage.setItem(IMPORT_DESIGN_DRAFT_KEY, JSON.stringify(design));
    } catch (err) {
      console.error("Failed to stash claimed design:", err);
      setError("Couldn't save the draft in your browser. Please try again.");
      setClaiming(false);
      return;
    }
    // The mere presence of the draft steers the signup flow to end on the stall
    // editor with the design applied (see new-account + stripe-connect).
    // plan=pro preselects the paid tier; preselect=seller skips the role step.
    router.push("/onboarding/new-account?plan=pro&preselect=seller");
  };

  const previewColors = design?.storefront.colorScheme ?? FALLBACK_COLORS;

  return (
    <>
      <Head>
        <title>Turn your website into a Milk Market stall — free preview</title>
        <meta
          name="description"
          content="Paste your website address and instantly preview how your shop would look as a Milk Market stall. No account needed."
        />
        <meta
          property="og:title"
          content="See your website as a Milk Market stall"
        />
        <meta
          property="og:description"
          content="Instant, free preview — paste a URL and see your shop reimagined as a Milk Market stall."
        />
        <meta
          property="og:image"
          content="https://milk.market/milk-market.png"
        />
        <meta name="twitter:card" content="summary_large_image" />
      </Head>

      <div className="min-h-screen bg-white font-sans text-black">
        <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
          {/* Hero */}
          <div className="mx-auto max-w-3xl text-center">
            <span className="bg-primary-yellow inline-flex items-center gap-1.5 rounded-full border-2 border-black px-3 py-1 text-xs font-bold">
              <SparklesIcon className="h-4 w-4" />
              Free instant preview — no account needed
            </span>
            <h1 className="mt-5 text-4xl font-black md:text-6xl">
              See your website as a Milk Market stall
            </h1>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-gray-700">
              Paste your shop&apos;s web address and we&apos;ll instantly build
              a matching stall design — your colors, fonts, logo, and words.
              Like what you see? Claim it and it&apos;s ready to save.
            </p>
          </div>

          {/* URL form */}
          <div className="mx-auto mt-8 max-w-2xl">
            <div className="flex flex-col gap-3 sm:flex-row">
              <Input
                aria-label="Website address"
                placeholder="yourshop.com"
                value={url}
                onValueChange={setUrl}
                variant="bordered"
                classNames={INPUT_CLASSNAMES}
                startContent={
                  <GlobeAltIcon className="h-5 w-5 text-gray-500" />
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !loading) runPreview(url);
                }}
              />
              <Button
                className={`${BLUEBUTTONCLASSNAMES} h-14 shrink-0 px-6 text-base`}
                onClick={() => runPreview(url)}
                isDisabled={loading}
                startContent={!loading && <SparklesIcon className="h-5 w-5" />}
              >
                {loading ? "Building…" : "Preview my stall"}
              </Button>
            </div>
            <p className="mt-2 text-center text-xs text-gray-500">
              Nothing is published. This just shows you a preview.
            </p>

            {error && (
              <div className="mt-4 flex items-start gap-2 rounded-md border-2 border-red-500 bg-red-50 p-3 text-sm text-red-700">
                <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}
          </div>

          {/* Loading */}
          {loading && (
            <div className="mt-12 flex flex-col items-center justify-center gap-4 text-center">
              <Spinner size="lg" />
              <div>
                <p className="flex items-center justify-center gap-2 font-bold">
                  <SparklesIcon className="h-5 w-5" />
                  Building your stall design…
                </p>
                <p className="mt-1 text-sm text-gray-600">
                  Reading your site and composing a matching look. This can take
                  a few seconds.
                </p>
              </div>
            </div>
          )}

          {/* Preview */}
          {!loading && design && (
            <div className="mt-12">
              <div className="mb-4 flex flex-col items-center gap-2 text-center">
                <div className="flex items-center gap-2">
                  <h2 className="text-2xl font-black md:text-3xl">
                    Here&apos;s your stall
                  </h2>
                  {design.aiApplied && (
                    <span className="bg-primary-yellow inline-flex items-center gap-1 rounded-full border-2 border-black px-2 py-0.5 text-xs font-bold whitespace-nowrap">
                      <SparklesIcon className="h-3.5 w-3.5" />
                      AI styled
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-600">
                  Based on{" "}
                  <span className="font-bold break-all">
                    {design.sourceUrl}
                  </span>
                </p>
              </div>

              <div className="shadow-neo overflow-hidden rounded-lg border-4 border-black">
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
                  navColors={design.storefront.navColors}
                  footerColors={design.storefront.footerColors}
                  shopSlug="preview"
                  compact
                />
              </div>

              {/* CTA */}
              <div className="mt-8 flex flex-col items-center gap-4 rounded-lg border-4 border-black bg-yellow-50 p-6 text-center">
                <h3 className="text-xl font-black md:text-2xl">
                  Love it? Make it yours.
                </h3>
                <p className="max-w-xl text-sm text-gray-700">
                  Claim this design to create your seller account and start your
                  plan. We&apos;ll drop you right into your stall editor with
                  everything above pre-loaded — just hit Save.
                </p>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Button
                    className={`${BLUEBUTTONCLASSNAMES} px-8 text-base`}
                    onClick={handleClaim}
                    isDisabled={claiming}
                    endContent={<ArrowLongRightIcon className="h-5 w-5" />}
                  >
                    {claiming ? "Loading…" : "Claim this design"}
                  </Button>
                  <Button
                    className={WHITEBUTTONCLASSNAMES}
                    onClick={() => {
                      setDesign(null);
                      setError(null);
                    }}
                    startContent={<ArrowPathIcon className="h-5 w-5" />}
                  >
                    Try another site
                  </Button>
                </div>
                <p className="text-xs text-gray-500">
                  Start with a 30-day free trial or a one-time lifetime plan.
                </p>
              </div>
            </div>
          )}

          {/* Value props (only before a preview, to keep the page focused) */}
          {!design && !loading && (
            <div className="mx-auto mt-16 grid max-w-4xl gap-6 sm:grid-cols-3">
              {VALUE_PROPS.map((f, i) => (
                <div
                  key={f.title}
                  className="rounded-lg border-2 border-black bg-white p-5"
                >
                  <div className="bg-primary-yellow mb-3 inline-flex h-9 w-9 items-center justify-center rounded-md border-2 border-black font-black">
                    {i + 1}
                  </div>
                  <h3 className="font-black">{f.title}</h3>
                  <p className="mt-1 text-sm text-gray-600">{f.body}</p>
                </div>
              ))}
            </div>
          )}

          <p className="mt-16 flex items-center justify-center gap-1.5 text-center text-xs text-gray-500">
            <CheckCircleIcon className="h-4 w-4" />
            Your current site stays exactly as it is. Nothing changes until you
            claim and save.
          </p>
        </div>
      </div>
    </>
  );
}
