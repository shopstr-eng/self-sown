import SeoHub, { type SeoHubLink } from "@/components/seo/seo-hub";
import { GUIDES } from "@/utils/seo/guides";

const LINKS: SeoHubLink[] = Object.values(GUIDES).map((p) => ({
  href: p.path,
  label: p.h1.replace(" (2026)", ""),
  description: p.metaDescription,
}));

export default function BestIndex() {
  return (
    <SeoHub
      h1="Best-of guides for sellers"
      blurb="The best online marketplace for your kind of farm, ranch, homestead, or craft — honestly ranked, competitors included, with real 2026 prices."
      links={LINKS}
    />
  );
}
