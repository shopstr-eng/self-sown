import {
  blossomUpload,
  getLocalStorageData,
} from "@/utils/nostr/nostr-helper-functions";
import type { NostrSigner } from "@/utils/nostr/signers/nostr-signer";
import type {
  ImportedStoreDesign,
  ImportedProductPage,
} from "@/utils/migrations/site-design";

export interface StorefrontImageRehostResult {
  design: ImportedStoreDesign;
  warnings: string[];
}

export interface ProductPageImageRehostResult {
  design: ImportedProductPage;
  warnings: string[];
}

const NO_MEDIA_SERVER_WARNING =
  "No media server is configured, so imported images still point at the original website and may break later. Add a media server in Settings → Preferences, then re-import to fix this.";

/**
 * Re-uploads the images referenced by an imported stall design (logo, banner,
 * section images, OG image) to the seller's own Blossom media servers and
 * swaps in the new URLs. Fail-open: if a server isn't configured or an upload
 * fails, the original URL is kept and a warning is recorded so the seller can
 * fix it later — an import should never be blocked by a flaky remote image.
 */
export async function rehostStorefrontDesignImages(
  design: ImportedStoreDesign,
  signer: NostrSigner
): Promise<StorefrontImageRehostResult> {
  const warnings: string[] = [];
  const blossomServers = getLocalStorageData().blossomServers || [];

  // Gather the unique remote URLs we want to rehost.
  const urls = new Set<string>();
  if (design.logoUrl) urls.add(design.logoUrl);
  if (design.bannerUrl) urls.add(design.bannerUrl);
  if (design.storefront.seoMeta?.ogImage)
    urls.add(design.storefront.seoMeta.ogImage);
  for (const section of design.storefront.sections ?? []) {
    if (section.image) urls.add(section.image);
    for (const slide of section.bannerSlides ?? []) {
      if (slide.image) urls.add(slide.image);
    }
  }

  if (urls.size === 0) {
    return { design, warnings };
  }

  if (blossomServers.length === 0) {
    warnings.push(NO_MEDIA_SERVER_WARNING);
    return { design, warnings };
  }

  const urlMap = await rehostUrls(urls, signer, blossomServers, warnings);

  if (urlMap.size === 0) {
    return {
      design: { ...design, warnings: [...design.warnings, ...warnings] },
      warnings,
    };
  }

  const remap = (u: string | undefined) => (u ? (urlMap.get(u) ?? u) : u);

  const rehosted: ImportedStoreDesign = {
    ...design,
    logoUrl: remap(design.logoUrl),
    bannerUrl: remap(design.bannerUrl),
    storefront: {
      ...design.storefront,
      sections: design.storefront.sections?.map((s) => {
        let next = s;
        if (next.image) next = { ...next, image: remap(next.image) };
        if (next.bannerSlides?.length) {
          next = {
            ...next,
            bannerSlides: next.bannerSlides.map((slide) =>
              slide.image
                ? { ...slide, image: remap(slide.image) as string }
                : slide
            ),
          };
        }
        return next;
      }),
      seoMeta: design.storefront.seoMeta
        ? {
            ...design.storefront.seoMeta,
            ogImage: remap(design.storefront.seoMeta.ogImage),
          }
        : design.storefront.seoMeta,
    },
    warnings: [...design.warnings, ...warnings],
  };

  return { design: rehosted, warnings };
}

/**
 * Product-page equivalent of rehostStorefrontDesignImages: rehosts the images
 * referenced by an imported product page (section images + OG image) to the
 * seller's Blossom servers and swaps in the new URLs. Same fail-open semantics.
 */
export async function rehostProductPageImages(
  design: ImportedProductPage,
  signer: NostrSigner
): Promise<ProductPageImageRehostResult> {
  const warnings: string[] = [];
  const blossomServers = getLocalStorageData().blossomServers || [];

  const urls = new Set<string>();
  for (const section of design.sections ?? []) {
    if (section.image) urls.add(section.image);
  }
  if (design.ogImage) urls.add(design.ogImage);

  if (urls.size === 0) {
    return { design, warnings };
  }

  if (blossomServers.length === 0) {
    warnings.push(NO_MEDIA_SERVER_WARNING);
    return { design, warnings };
  }

  const urlMap = await rehostUrls(urls, signer, blossomServers, warnings);

  if (urlMap.size === 0) {
    return {
      design: { ...design, warnings: [...design.warnings, ...warnings] },
      warnings,
    };
  }

  const remap = (u: string | undefined) => (u ? (urlMap.get(u) ?? u) : u);

  const rehosted: ImportedProductPage = {
    ...design,
    sections: design.sections?.map((s) =>
      s.image ? { ...s, image: remap(s.image) as string } : s
    ),
    ogImage: remap(design.ogImage),
    warnings: [...design.warnings, ...warnings],
  };

  return { design: rehosted, warnings };
}

// Shared upload loop: rehosts every URL in `urls` to Blossom, recording a
// warning (never throwing) for each one that fails. Returns the old→new map.
async function rehostUrls(
  urls: Set<string>,
  signer: NostrSigner,
  blossomServers: string[],
  warnings: string[]
): Promise<Map<string, string>> {
  const urlMap = new Map<string, string>();
  for (const url of urls) {
    try {
      const file = await fetchRemoteImageAsFile(url);
      const tags = await blossomUpload(file, true, signer, blossomServers);
      const newUrl = tags.find((t) => t[0] === "url")?.[1];
      if (newUrl) {
        urlMap.set(url, newUrl);
      } else {
        warnings.push(
          `Couldn't move ${shortUrl(url)} to your media server (no URL returned); kept the original link.`
        );
      }
    } catch (err) {
      console.error("Failed to rehost storefront image", url, err);
      const reason = err instanceof Error ? err.message : "unknown error";
      warnings.push(
        `Couldn't move ${shortUrl(url)} to your media server (${reason}); kept the original link.`
      );
    }
  }
  return urlMap;
}

async function fetchRemoteImageAsFile(url: string): Promise<File> {
  const res = await fetch(url, { mode: "cors", credentials: "omit" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) {
    throw new Error(
      blob.type ? `unexpected content type ${blob.type}` : "not an image"
    );
  }
  return new File([blob], guessFilename(url, blob.type), { type: blob.type });
}

function guessFilename(url: string, mime: string): string {
  const ext = mime.split("/")[1] || "jpg";
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    if (last && last.includes(".")) return last;
  } catch {
    // ignore
  }
  return `imported-image.${ext}`;
}

function shortUrl(url: string): string {
  return url.length <= 60 ? url : url.slice(0, 30) + "…" + url.slice(-25);
}
