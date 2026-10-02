import SeoHub, { type SeoHubLink } from "@/components/seo/seo-hub";
import { VS_PAGES } from "@/utils/seo/vs-pages";

const LINKS: SeoHubLink[] = Object.values(VS_PAGES).map((p) => ({
  href: p.path,
  label: p.h1.replace(" (2026)", ""),
  description: p.metaDescription,
}));

export default function VsIndex() {
  return (
    <SeoHub
      h1="Honest comparisons"
      blurb="Self-sown vs the platforms farmers and makers actually use. Real prices, real tradeoffs — including where the other platform is the better choice."
      links={LINKS}
    />
  );
}
