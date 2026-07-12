import Head from "next/head";
import { useRouter } from "next/router";
import { safeJsonLdString } from "@/utils/safe-json-ld";
import { HOMEPAGE_FAQ } from "@/utils/homepage-faq";

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Milk Market",
  url: "https://milk.market",
  logo: "https://milk.market/milk-market.png",
  description:
    "Milk Market is a decentralized, permissionless marketplace connecting local dairy farmers directly with consumers. Zero platform fees, direct payments via Bitcoin and traditional methods.",
  foundingDate: "2024",
  contactPoint: {
    "@type": "ContactPoint",
    email: "freemilk@milk.market",
    contactType: "customer service",
    availableLanguage: "English",
  },
  sameAs: [
    "https://github.com/shopstr-eng/milk-market",
    "https://x.com/milkmarketmedia",
    "https://www.youtube.com/@milkmarketmedia",
    "https://www.instagram.com/milkmarketmedia/",
    "https://www.tiktok.com/@milkmarket.media",
  ],
  founder: {
    "@type": "Person",
    name: "Milk Market Team",
    description:
      "Advocates for food sovereignty and direct farm-to-consumer commerce, with expertise in decentralized marketplace technology and dairy supply chains.",
  },
};

const localBusinessSchema = {
  "@context": "https://schema.org",
  "@type": "LocalBusiness",
  name: "Milk Market",
  url: "https://milk.market",
  logo: "https://milk.market/milk-market.png",
  image: "https://milk.market/milk-market.png",
  description:
    "Farm-fresh dairy marketplace connecting local farmers with buyers. Browse raw milk, cheese, butter, and more from trusted local producers with zero platform fees.",
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
  name: "Milk Market",
  url: "https://milk.market",
  description:
    "Farm-fresh dairy marketplace. Buy raw milk, cheese, and dairy products direct from local farmers with zero platform fees.",
  potentialAction: {
    "@type": "SearchAction",
    target: {
      "@type": "EntryPoint",
      urlTemplate: "https://milk.market/marketplace?q={search_term_string}",
    },
    "query-input": "required name=search_term_string",
  },
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
    </Head>
  );
}
