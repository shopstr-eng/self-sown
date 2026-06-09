import Head from "next/head";
import { useRouter } from "next/router";
import { safeJsonLdString } from "@/utils/safe-json-ld";

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
  mainEntity: [
    {
      "@type": "Question",
      name: "What can I sell on Milk Market?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Food producers and local artisans can sell almost anything they make - raw milk and dairy, meat and eggs, produce, baked goods, preserves, honey, herdshares, and handmade goods. You set your own prices, pickup, delivery, and payment methods.",
      },
    },
    {
      "@type": "Question",
      name: "How much does it cost to sell?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Starting is free, with unlimited listings and no mandatory transaction fees, ever. Herd is $21/month (or $168/year) and adds custom domains, advanced storefront design, automated email flows, shipping labels (coming soon), and AI agent (MCP) access. Prefer to pay once? Wrangler is a one-time $1,050 purchase for lifetime access to every Herd feature. New sellers get a 30-day free trial of Herd, with no payment required up front. You can set an optional donation rate to support the platform, but that's always your choice.",
      },
    },
    {
      "@type": "Question",
      name: "Do I own my customers and store?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. Milk Market is built on Nostr, an open and decentralized network. Your storefront and customer relationships belong to you - not a single company. No one can freeze your account or deplatform you.",
      },
    },
    {
      "@type": "Question",
      name: "How do payments work?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Buyers can pay with a card, Bitcoin (Lightning and Cashu ecash), or cash for local pickup. Sellers connect their own payout method and get paid directly - there's no middleman holding your money.",
      },
    },
    {
      "@type": "Question",
      name: "Is my information private?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. All your data is encrypted and private. We never sell user data or share it with third parties. The platform is built on Nostr, a decentralized protocol designed for privacy and ownership.",
      },
    },
    {
      "@type": "Question",
      name: "I'm already on Shopify or Barn2Door. Can I switch?",
      acceptedAnswer: {
        "@type": "Answer",
        text: "Yes. You can migrate from Shopify in a few clicks and keep your products. Click 'Start Selling' or 'Migrate from Shopify' to bring your catalog over and open your storefront in minutes.",
      },
    },
  ],
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
