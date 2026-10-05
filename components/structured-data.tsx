import Head from "next/head";
import { useRouter } from "next/router";
import { safeJsonLdString } from "@/utils/safe-json-ld";
import { HOMEPAGE_FAQ } from "@/utils/homepage-faq";
import { SITE_URL } from "@/utils/site-url";
import {
  PRO_ANNUAL_PRICE_CENTS,
  PRO_MONTHLY_PRICE_CENTS,
  WRANGLER_LIFETIME_PRICE_CENTS,
} from "@/utils/pro/constants";

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Self-sown",
  url: SITE_URL,
  logo: `${SITE_URL}/self-sown-black.png`,
  description:
    "Self-sown is a decentralized, permissionless marketplace connecting local food producers and artisans directly with consumers. Zero platform fees, direct payments via Bitcoin and traditional methods.",
  foundingDate: "2024",
  contactPoint: {
    "@type": "ContactPoint",
    email: "hello@self-sown.com",
    contactType: "customer service",
    availableLanguage: "English",
  },
  // Identity links that let agents disambiguate the brand from similarly
  // named entities (repo, org, video channel, Nostr identity).
  sameAs: [
    "https://github.com/shopstr-eng",
    "https://github.com/shopstr-eng/self-sown",
    "https://www.youtube.com/@self-sown",
    "https://njump.me/self-sown@self-sown.com",
  ],
  founder: {
    "@type": "Person",
    name: "Self-sown Team",
    description:
      "Advocates for food sovereignty and direct farm-to-consumer commerce, with expertise in decentralized marketplace technology and dairy supply chains.",
  },
};

const localBusinessSchema = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Self-sown",
  url: SITE_URL,
  logo: `${SITE_URL}/self-sown-black.png`,
  image: `${SITE_URL}/self-sown-black.png`,
  description:
    "Local food and artisan goods marketplace connecting independent producers with buyers. Browse farm-fresh food, handmade goods, and more from trusted local sellers with zero platform fees.",
  address: {
    "@type": "PostalAddress",
    addressLocality: "Seattle",
    addressRegion: "WA",
    addressCountry: "US",
  },
  priceRange: "$$",
  openingHoursSpecification: {
    "@type": "OpeningHoursSpecification",
    dayOfWeek: [
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ],
    opens: "00:00",
    closes: "23:59",
  },
  areaServed: {
    "@type": "Country",
    name: "United States",
  },
};

const homepageFaqSchema = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: HOMEPAGE_FAQ.map((item) => ({
    "@type": "Question",
    name: item.question,
    acceptedAnswer: {
      "@type": "Answer",
      text: item.answer,
    },
  })),
};

const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: "Self-sown",
  url: SITE_URL,
  description:
    "Local food and artisan goods marketplace. Buy farm-fresh food and handmade goods direct from local producers with zero platform fees.",
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: `${SITE_URL}/marketplace?q={search_term_string}`,
    },
    "query-input": "required name=search_term_string",
  },
};

const usdPrice = (cents: number) => (cents / 100).toFixed(2);

// Seller-plan pricing as schema.org Offers so agents can discover it without
// scraping the marketing section. Prices come from utils/pro/constants (the
// same source the checkout charges), never hardcoded here.
const serviceSchema = {
  "@context": "https://schema.org",
  "@type": "Service",
  name: "Self-sown seller plans",
  provider: { "@type": "Organization", name: "Self-sown", url: SITE_URL },
  serviceType: "Marketplace seller membership",
  description:
    "Sell local food and artisan goods with zero platform fees. The Free plan includes unlimited listings; Herd adds custom domains, automated email flows, and MCP API access for AI agents; Wrangler lifetime adds self-hosting.",
  offers: [
    {
      "@type": "Offer",
      name: "Free",
      price: "0.00",
      priceCurrency: "USD",
      description: "Unlimited product listings, seller profile, and payouts.",
    },
    {
      "@type": "Offer",
      name: "Herd (monthly)",
      price: usdPrice(PRO_MONTHLY_PRICE_CENTS),
      priceCurrency: "USD",
      description: "Per month. 30-day free trial for new sellers.",
    },
    {
      "@type": "Offer",
      name: "Herd (yearly)",
      price: usdPrice(PRO_ANNUAL_PRICE_CENTS),
      priceCurrency: "USD",
      description: "Per year.",
    },
    {
      "@type": "Offer",
      name: "Wrangler (lifetime)",
      price: usdPrice(WRANGLER_LIFETIME_PRICE_CENTS),
      priceCurrency: "USD",
      description: "One-time payment; includes self-hosting.",
    },
  ],
};

export default function StructuredData() {
  const router = useRouter();
  const isHomePage = router.pathname === "/";
  const isAboutPage = router.pathname === "/about";
  const isContactPage = router.pathname === "/contact";

  return (
    <Head>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdString(organizationSchema),
        }}
      />
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: safeJsonLdString(websiteSchema),
        }}
      />
      {(isHomePage || isAboutPage || isContactPage) && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(localBusinessSchema),
          }}
        />
      )}
      {isHomePage && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLdString(homepageFaqSchema),
          }}
        />
      )}
      {isHomePage && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: safeJsonLdString(serviceSchema),
          }}
        />
      )}
    </Head>
  );
}
