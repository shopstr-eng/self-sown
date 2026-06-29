import type { ProductData } from "@/utils/parsers/product-parser-functions";
import type { ProfileData } from "@/utils/types/types";
import { nip19 } from "nostr-tools";

export interface ListingSlugCandidate {
  id: string;
  title: string;
  pubkey: string;
}

export function titleToSlug(title: string): string {
  if (!title) return "";
  return title
    .trim()
    .replace(/[#?&\/\\%=+<>{}|^~\[\]`@!$*()"';:,]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function getListingSlug(
  product: ListingSlugCandidate,
  allProducts: ListingSlugCandidate[]
): string {
  const baseSlug = titleToSlug(product.title);
  if (!baseSlug) {
    return product.id;
  }

  const collisions = allProducts.filter(
    (p) => titleToSlug(p.title) === baseSlug
  );

  if (collisions.length <= 1) {
    return baseSlug;
  }

  return `${baseSlug}-${product.pubkey.substring(0, 8)}`;
}

export function findListingBySlug<T extends ListingSlugCandidate>(
  slug: string,
  allProducts: T[]
): T | undefined {
  const pubkeySuffixMatch = slug.match(/^(.+)-([a-f0-9]{8})$/);
  if (pubkeySuffixMatch) {
    const baseSlug = pubkeySuffixMatch[1]!;
    const pubkeyFragment = pubkeySuffixMatch[2]!;
    const match = allProducts.find(
      (p) =>
        titleToSlug(p.title) === baseSlug && p.pubkey.startsWith(pubkeyFragment)
    );
    if (match) return match;
  }

  const plainMatches = allProducts.filter((p) => titleToSlug(p.title) === slug);
  if (plainMatches.length >= 1) {
    return plainMatches[0];
  }

  return undefined;
}

export function findProductBySlug(
  slug: string,
  allProducts: ProductData[]
): ProductData | undefined {
  return findListingBySlug(slug, allProducts);
}

export function profileNameToSlug(name: string): string {
  if (!name) return "";
  return name
    .trim()
    .replace(/[#?&\/\\%=+<>{}|^~\[\]`@!$*()"';:,]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function getProfileSlug(
  pubkey: string,
  profileData: Map<string, ProfileData>
): string {
  const profile = profileData.get(pubkey);
  const name = profile?.content?.name;
  if (!name) {
    return nip19.npubEncode(pubkey);
  }

  const baseSlug = profileNameToSlug(name);
  if (!baseSlug) {
    return nip19.npubEncode(pubkey);
  }

  const collisions = Array.from(profileData.values()).filter(
    (p) => p.content?.name && profileNameToSlug(p.content.name) === baseSlug
  );

  if (collisions.length <= 1) {
    return baseSlug;
  }

  return `${baseSlug}-${pubkey.substring(0, 8)}`;
}

export function findPubkeyByProfileSlug(
  slug: string,
  profileData: Map<string, ProfileData>
): string | undefined {
  const matches: string[] = [];
  for (const [pubkey, profile] of profileData.entries()) {
    if (
      profile.content?.name &&
      profileNameToSlug(profile.content.name) === slug
    ) {
      matches.push(pubkey);
    }
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    return undefined;
  }

  const pubkeySuffixMatch = slug.match(/^(.+)-([a-f0-9]{8})$/);
  if (pubkeySuffixMatch) {
    const baseSlug = pubkeySuffixMatch[1]!;
    const pubkeyFragment = pubkeySuffixMatch[2]!;
    for (const [pubkey, profile] of profileData.entries()) {
      if (
        profile.content?.name &&
        profileNameToSlug(profile.content.name) === baseSlug &&
        pubkey.startsWith(pubkeyFragment)
      ) {
        return pubkey;
      }
    }
  }

  return undefined;
}

export interface BlogPostSlugCandidate {
  title: string;
  dTag: string;
}

// Blog posts are scoped to a single seller, so the readable slug is just the
// title slug. On collision (two posts with the same title slug) we fall back to
// a short d-tag suffix so the URL still resolves to exactly one post. Edits that
// change the title change the slug (same tradeoff as product listings).
export function getBlogPostSlug<T extends BlogPostSlugCandidate>(
  post: T,
  allPosts: T[]
): string {
  const baseSlug = titleToSlug(post.title);
  if (!baseSlug) return post.dTag;

  const collisions = allPosts.filter((p) => titleToSlug(p.title) === baseSlug);
  if (collisions.length <= 1) return baseSlug;

  return `${baseSlug}-${post.dTag.substring(0, 8)}`;
}

export function findBlogPostBySlug<T extends BlogPostSlugCandidate>(
  slug: string,
  allPosts: T[]
): T | undefined {
  // Exact d-tag match first (stable identifier links never break).
  const byDTag = allPosts.find((p) => p.dTag === slug);
  if (byDTag) return byDTag;

  const suffixMatch = slug.match(/^(.+)-([a-f0-9]{8})$/);
  if (suffixMatch) {
    const baseSlug = suffixMatch[1]!;
    const dTagFragment = suffixMatch[2]!;
    const match = allPosts.find(
      (p) =>
        titleToSlug(p.title) === baseSlug && p.dTag.startsWith(dTagFragment)
    );
    if (match) return match;
  }

  const plainMatches = allPosts.filter((p) => titleToSlug(p.title) === slug);
  if (plainMatches.length >= 1) return plainMatches[0];

  return undefined;
}

export function isNaddr(str: string): boolean {
  return str.startsWith("naddr1");
}

export function isNpub(str: string): boolean {
  return str.startsWith("npub1");
}
