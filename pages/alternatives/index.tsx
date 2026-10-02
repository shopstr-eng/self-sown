import SeoHub, { type SeoHubLink } from "@/components/seo/seo-hub";
import { ALTERNATIVES_PAGES } from "@/utils/seo/alternatives-pages";

const LINKS: SeoHubLink[] = Object.values(ALTERNATIVES_PAGES).map((p) => ({
  href: p.path,
  label: p.h1.replace(" (2026)", ""),
  description: p.metaDescription,
}));

export default function AlternativesIndex() {
  return (
    <SeoHub
      h1="Platform alternatives"
      blurb="Looking for a way off Shopify, Etsy, Barn2Door, or the rest? Each guide compares the real alternatives for farm, food, and artisan sellers — with prices, not vibes."
      links={LINKS}
    />
  );
}
