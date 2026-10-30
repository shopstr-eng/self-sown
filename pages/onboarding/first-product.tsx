import { useContext, useRef, useState } from "react";
import { useRouter } from "next/router";
import {
  Card,
  CardBody,
  Button,
  Image,
  Input,
  Textarea,
  Select,
  SelectItem,
} from "@heroui/react";
import {
  ArrowLongRightIcon,
  ArrowLeftEndOnRectangleIcon,
  PhotoIcon,
} from "@heroicons/react/24/outline";
import {
  BLUEBUTTONCLASSNAMES,
  WHITEBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";
import {
  NostrContext,
  SignerContext,
} from "@/components/utility-components/nostr-context-provider";
import { ProductContext } from "@/utils/context/context";
import {
  PostListing,
  blossomUpload,
  getLocalStorageData,
} from "@/utils/nostr/nostr-helper-functions";
import { createSellerListingDTag } from "@self-sown/nostr";
import { ProductFormValues } from "@/utils/types/types";
import currencySelection from "../../public/currencySelection.json";

// Same currency source as the full product editor.
const CURRENCY_OPTIONS = Object.keys(currencySelection);

const OnboardingFirstProduct = () => {
  const router = useRouter();
  const { signer, isLoggedIn } = useContext(SignerContext);
  const { nostr } = useContext(NostrContext);
  const productEventContext = useContext(ProductContext);

  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [description, setDescription] = useState("");
  const [imageUrl, setImageUrl] = useState("");
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const migrate = router.query.migrate as string | undefined;
  const plan = router.query.plan as string | undefined;
  const buildQuery = () => {
    const params = new URLSearchParams();
    if (plan) params.set("plan", plan);
    if (migrate) params.set("migrate", migrate);
    const s = params.toString();
    return s ? `?${s}` : "";
  };

  const handleImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !signer) return;
    setIsUploadingImage(true);
    setError(null);
    try {
      const { blossomServers } = getLocalStorageData() || {};
      const tags = await blossomUpload(
        file,
        true,
        signer,
        blossomServers || ["https://cdn.nostrcheck.me"]
      );
      const urlTag = tags.find((t) => t[0] === "url");
      if (!urlTag?.[1]) throw new Error("Upload returned no URL");
      setImageUrl(urlTag[1]);
    } catch (err) {
      console.error("First-product image upload failed:", err);
      setError("Photo upload failed — you can still publish without one.");
    } finally {
      setIsUploadingImage(false);
      e.target.value = "";
    }
  };

  const handlePublish = async () => {
    if (!title.trim() || !price.trim()) {
      setError("A name and a price are all your first product needs.");
      return;
    }
    if (!/^\d+(\.\d{1,2})?$/.test(price.trim())) {
      setError("Price should be a number like 12 or 12.50.");
      return;
    }
    if (!signer || !isLoggedIn || !nostr) {
      setError("Still setting up your account — try again in a moment.");
      return;
    }
    setIsPublishing(true);
    setError(null);
    try {
      const userPubkey = await signer.getPubKey();
      const { relays } = getLocalStorageData() || { relays: [] };
      const dTag = createSellerListingDTag();
      // Mirrors the essential tag set from components/product-form.tsx — the
      // full editor (shipping, variants, stock) stays one tap away in
      // settings once the seller has something live.
      const tags: ProductFormValues = [
        ["d", dTag],
        ["alt", `Product listing: ${title.trim()}`],
        [
          "client",
          "Self-sown",
          `31990:${userPubkey}:${dTag}`,
          relays?.[0] || "",
        ],
        ["title", title.trim()],
        ["summary", description.trim()],
        ["price", price.trim(), currency],
        ["location", ""],
        ["shipping", "", "0", currency],
        ["t", "SelfSown"],
        ["t", "FREEMILK"],
      ];
      if (imageUrl) tags.push(["image", imageUrl]);

      const signedListing = await PostListing(tags, signer, isLoggedIn, nostr);
      // Upsert into the local product context (deduped by pubkey:d-tag) so the
      // listing is visible immediately, without waiting on a relay round-trip.
      productEventContext.addNewlyCreatedProductEvent(signedListing);
      router.push(`/onboarding/stripe-connect${buildQuery()}`);
    } catch (err) {
      console.error("First-product publish failed:", err);
      setError(
        "Publishing failed — check your connection and try again, or skip and add a product later from settings."
      );
      setIsPublishing(false);
    }
  };

  const handleSkip = () => {
    router.push(`/onboarding/stripe-connect${buildQuery()}`);
  };

  return (
    <div className="flex min-h-screen flex-col bg-white pt-24">
      <div className="mx-auto w-full max-w-2xl px-4 py-6">
        <Card className="shadow-neo rounded-md border-4 border-black bg-white">
          <CardBody className="p-8">
            <div className="mb-6 flex flex-row items-center justify-center gap-3">
              <Image
                alt="Self-sown logo"
                height={50}
                radius="sm"
                src="/self-sown-black.png"
                width={50}
              />
              <h1 className="text-center text-3xl font-bold text-black">
                Self-sown
              </h1>
            </div>
            <div className="mb-6 text-center">
              <h2 className="mb-3 text-2xl font-bold text-black">
                Step {plan ? 6 : 5}: Add Your First Product
              </h2>
              <p className="font-medium text-black">
                Your stall works best with something in it. Name one thing you
                sell — you can add photos, shipping, and the rest later.
              </p>
            </div>

            <div className="flex flex-col space-y-5">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => void handleImagePick(e)}
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isUploadingImage}
                className="flex h-40 w-full items-center justify-center overflow-hidden rounded-md border-3 border-dashed border-black bg-gray-50 hover:bg-gray-100"
              >
                {imageUrl ? (
                  <img
                    src={imageUrl}
                    alt="Product photo"
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span className="flex flex-col items-center gap-2 text-black">
                    <PhotoIcon className="h-8 w-8" />
                    <span className="text-sm font-bold">
                      {isUploadingImage
                        ? "Uploading photo..."
                        : "Add a photo (optional)"}
                    </span>
                  </span>
                )}
              </button>

              <div className="space-y-2">
                <label className="block text-base font-bold text-black">
                  Product name <span className="text-red-500">*</span>
                </label>
                <Input
                  fullWidth
                  size="lg"
                  value={title}
                  placeholder="e.g. Fresh farm eggs"
                  onChange={(e) => setTitle(e.target.value)}
                  classNames={{
                    input:
                      "text-base !text-black font-medium placeholder:text-gray-400",
                    inputWrapper:
                      "!bg-white border-3 border-black rounded-md shadow-none hover:!bg-white group-data-[hover=true]:!bg-white group-data-[focus=true]:!bg-white h-12 transition-none",
                  }}
                />
              </div>

              <div className="flex gap-3">
                <div className="flex-1 space-y-2">
                  <label className="block text-base font-bold text-black">
                    Price <span className="text-red-500">*</span>
                  </label>
                  <Input
                    fullWidth
                    size="lg"
                    inputMode="decimal"
                    value={price}
                    placeholder="12.50"
                    onChange={(e) => setPrice(e.target.value)}
                    classNames={{
                      input:
                        "text-base !text-black font-medium placeholder:text-gray-400",
                      inputWrapper:
                        "!bg-white border-3 border-black rounded-md shadow-none hover:!bg-white group-data-[hover=true]:!bg-white group-data-[focus=true]:!bg-white h-12 transition-none",
                    }}
                  />
                </div>
                <div className="w-28 space-y-2">
                  <label className="block text-base font-bold text-black">
                    Currency
                  </label>
                  <Select
                    aria-label="Currency"
                    selectedKeys={[currency]}
                    onChange={(e) => setCurrency(e.target.value || "USD")}
                    classNames={{
                      trigger: "border-3 border-black rounded-md bg-white h-12",
                    }}
                  >
                    {CURRENCY_OPTIONS.map((c) => (
                      <SelectItem key={c}>{c}</SelectItem>
                    ))}
                  </Select>
                </div>
              </div>

              <div className="space-y-2">
                <label className="block text-base font-bold text-black">
                  Description{" "}
                  <span className="text-sm font-normal text-gray-400">
                    (Optional)
                  </span>
                </label>
                <Textarea
                  fullWidth
                  minRows={2}
                  value={description}
                  placeholder="A sentence or two is plenty for now..."
                  onChange={(e) => setDescription(e.target.value)}
                  classNames={{
                    input:
                      "text-base !text-black font-medium placeholder:text-gray-400",
                    inputWrapper:
                      "!bg-white border-3 border-black rounded-md shadow-none hover:!bg-white group-data-[hover=true]:!bg-white group-data-[focus=true]:!bg-white transition-none",
                  }}
                />
              </div>

              {error && (
                <p className="text-center text-sm font-medium text-red-500">
                  {error}
                </p>
              )}

              <div className="flex flex-col items-center gap-3 pt-2">
                <Button
                  className={BLUEBUTTONCLASSNAMES}
                  onClick={() => void handlePublish()}
                  isLoading={isPublishing}
                  isDisabled={isUploadingImage}
                >
                  Publish Product{" "}
                  <ArrowLongRightIcon className="ml-1 h-5 w-5" />
                </Button>
                <Button className={WHITEBUTTONCLASSNAMES} onClick={handleSkip}>
                  Skip for Now{" "}
                  <ArrowLeftEndOnRectangleIcon className="ml-1 h-5 w-5" />
                </Button>
              </div>
            </div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
};

export default OnboardingFirstProduct;
