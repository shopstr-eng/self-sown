import { sanitizeUrl } from "@braintree/sanitize-url";

const BLOCKED_URL = "about:blank";
const LOCAL_IMAGE_BASE_URL = "https://milk-market.invalid";
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

function isBlockedRemoteImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return true;
  }

  if (IPV4_RE.test(host)) {
    const parts = host.split(".").map(Number);
    if (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
    ) {
      return true;
    }
    const [a, b, c] = parts as [number, number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 2 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }

  const normalized = host.replace(/^\[|\]$/g, "");
  if (normalized === "::" || normalized === "::1") return true;
  const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
  return (
    normalized.includes(":") &&
    (!Number.isFinite(firstHextet) ||
      (firstHextet & 0xffc0) === 0xfe80 ||
      (firstHextet & 0xfe00) === 0xfc00 ||
      (firstHextet & 0xff00) === 0xff00 ||
      normalized.startsWith("::ffff:"))
  );
}

/**
 * Canonicalizes untrusted product image URLs without proxying them through the
 * app. Keeping external URLs direct avoids turning product views into a
 * referrer-bearing tracking hop or a server-side fetch primitive.
 */
export function normalizeProductImageUrl(
  image: string | undefined,
  fallback = "/no-image-placeholder.png"
): string {
  const trimmed = image?.trim();
  if (!trimmed || trimmed.startsWith("//")) return fallback;

  if (trimmed.startsWith("/")) {
    try {
      const local = new URL(trimmed, LOCAL_IMAGE_BASE_URL);
      return local.origin === LOCAL_IMAGE_BASE_URL &&
        !/^\/api\//i.test(local.pathname)
        ? `${local.pathname}${local.search}${local.hash}`
        : fallback;
    } catch {
      return fallback;
    }
  }

  const sanitized = sanitizeUrl(trimmed);
  if (!sanitized || sanitized === BLOCKED_URL) return fallback;
  try {
    const parsed = new URL(sanitized);
    if (
      !/^https?:$/i.test(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      isBlockedRemoteImageHost(parsed.hostname)
    ) {
      return fallback;
    }
    return parsed.toString();
  } catch {
    return fallback;
  }
}

export function normalizeProductImageUrls(
  images: string[] | undefined
): string[] {
  return images?.map((image) => normalizeProductImageUrl(image)) ?? [];
}

export function normalizeStoredProductImages<T extends { images?: string[] }>(
  products: T[]
): Array<T & { images: string[] }> {
  return products.map((product) => ({
    ...product,
    images: normalizeProductImageUrls(product.images),
  }));
}

const hostToSrcSet = (url: URL) => {
  const host = url.host;

  // add all known image hosting providers here and configure responsive src formatting
  switch (host) {
    case "image.nostr.build":
      return ["240", "480", "720", "1080"]
        .map((size) => `${url.origin}/resp/${size}p${url.pathname} ${size}w`)
        .join(", ");
    case "i.nostr.build":
      return ["240", "480", "720", "1080"]
        .map((size) => `${url.origin}/resp/${size}p${url.pathname} ${size}w`)
        .join(", ");
    default:
      return url.toString();
  }
};

export const buildSrcSet = (image: string) => {
  try {
    const url = new URL(image);
    return hostToSrcSet(url);
  } catch {
    return image;
  }
};
