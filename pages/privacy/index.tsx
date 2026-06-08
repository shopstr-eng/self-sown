import { useRouter } from "next/router";
import Head from "next/head";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

export default function PrivacyPolicy() {
  const router = useRouter();
  const policyContent = [
    {
      title: "Introduction",
      content:
        "Milk Market is committed to protecting your privacy and to being honest about the data we handle. The platform is built on two layers: a decentralized core (the Nostr protocol and the Bitcoin/Lightning network) that keeps you in control of your identity and funds, and a hosted backend we operate to make the marketplace fast and to power optional features like card payments, email notifications, custom domains, and analytics. This policy explains, plainly, what stays under your control, what we store on our servers, and how it is protected.",
    },
    {
      title: "How the Platform Is Structured",
      content:
        "Browsing, listing, and peer-to-peer messaging run on open Nostr and Bitcoin protocols, so much of your activity never requires an account with us. To support performance and optional features, we also operate a hosted backend: a PostgreSQL database that caches public Nostr data and stores account, payment, order, email, storefront, affiliate, and analytics records. We aim to minimize what we store, but we do store more than a purely static site would, and the sections below describe exactly what.",
    },
    {
      title: "Cached Nostr Data",
      content:
        "To deliver fast page loads, server-side rendering, search, and link previews, our backend caches public Nostr events in PostgreSQL. This includes product listings and metadata, shop and user profiles, reviews and comments, community posts, and relay/cart configuration. Encrypted direct messages and gift-wrapped order messages are cached only in their already-encrypted form — we store the ciphertext and cannot read their contents. This cached data mirrors what is already public on the relays you publish to.",
    },
    {
      title: "Account & Sign-In Data",
      content:
        "You can use much of Milk Market without an account. If you choose to sign in with an email address or a third-party (OAuth) provider, we store your email, a securely hashed version of your password (never the plaintext), and an encrypted copy of your Nostr secret key (nsec). Your nsec is encrypted with a key derived from your password or recovery key, so we cannot decrypt it or access your funds. Account recovery stores your email together with hashed recovery credentials and time-limited verification tokens.",
    },
    {
      title: "Bitcoin, Lightning & Cashu Data",
      content:
        "On-chain, Lightning, and Cashu payments occur on their respective networks and follow their own privacy models. These may involve transaction amounts, Bitcoin/Lightning addresses or payment requests, and time-stamped records. Cashu ecash provides additional privacy where implemented. We do not custody your funds.",
    },
    {
      title: "Card Payments & Stripe",
      content:
        "When you pay by card — for a Pro subscription, or for orders placed through our checkout and AI agent (MCP) flows — payment is processed by Stripe under its own privacy policy. We never store full card numbers. We do store payment identifiers and records needed to operate these features, such as Stripe customer, subscription, and connected-account IDs, payment status, and subscription details. Where an order is processed through us, we also store the order amount, currency, and the buyer email and shipping address needed for fulfillment (see Order & Shipping Information).",
    },
    {
      title: "Email & Notifications (SendGrid)",
      content:
        "If you provide an email address — to sign in, to receive order updates, for abandoned-cart reminders, or as an affiliate — we store that address in our database in plaintext so we can deliver messages through our email provider, SendGrid. Emails are used for transactional and lifecycle messaging and are not sold or rented for third-party marketing. You can opt out of non-essential emails using the unsubscribe link in any such message.",
    },
    {
      title: "Order & Shipping Information",
      content:
        "Order coordination conducted over Nostr direct messages is end-to-end encrypted and unreadable by us. However, to fulfill orders, certain details are stored on our servers in plaintext: when you check out as a guest, place an order via an AI agent, or pay by card, your buyer email and shipping address are stored so the seller can fulfill the order and so we can route notifications. Sellers receive the information needed to ship your order and are responsible for handling it.",
    },
    {
      title: "Analytics & Marketing Attribution",
      content:
        "We collect server-side analytics to understand traffic and to attribute referrals and affiliate links. This includes your IP address, browser user-agent, referrer, and UTM campaign parameters (source, medium, campaign, term, and content). This information helps us measure where visitors come from and credit affiliates correctly. We do not use it to build advertising profiles or sell it to advertisers.",
    },
    {
      title: "Sellers, Storefronts & Custom Domains",
      content:
        "If you sell on Milk Market, we store operational records for your storefront, including your shop URL slug, inventory counts and variants, and — if you connect a custom domain — the domain name along with its TLS and verification status. This data is used to run your storefront and route visitors to it.",
    },
    {
      title: "Affiliate Program Data",
      content:
        "If you participate in a seller's affiliate program, we store the information needed to track and pay you, including your name, email address, Lightning address, and (for card payouts) your Stripe account ID, as well as referral and payout records. This data is used to calculate commissions and settle payouts.",
    },
    {
      title: "Local Browser Storage",
      content:
        "Our web interface also keeps data locally in your browser that we cannot access, including in-browser keys (if you choose that storage option), user preferences, relay selections, and interface settings. You can clear this at any time through your browser settings.",
    },
    {
      title: "Third-Party Services",
      content:
        "Depending on how you use Milk Market, your data may be handled by third parties with their own privacy practices, including Stripe (card payments and payouts), SendGrid (email delivery), Nostr relays you select, Bitcoin/Lightning nodes, Cashu mints, Blossom media hosts, and DNS providers (for custom domains and NIP-05 verification). We recommend reviewing the privacy policies of any third-party services you rely on.",
    },
    {
      title: "Data Retention",
      content:
        "Cached Nostr data is retained to keep the marketplace responsive and may be refreshed or pruned over time. Account, payment, order, subscription, affiliate, and analytics records are retained as long as needed to provide the service and to meet legal, financial, and operational obligations. Content you publish to Nostr relays is outside our control and may persist on those relays according to each relay's own retention policy.",
    },
    {
      title: "Security Measures",
      content:
        "Security is maintained through open-source code (our codebase is publicly available for review), password hashing and encryption of sensitive material such as your nsec, encrypted transport, cryptographic protocols for communications, and Bitcoin network security for transactions. You remain responsible for safeguarding your private keys, passwords, and wallets.",
    },
    {
      title: "User Rights and Control",
      content:
        "You retain control over your private keys and funds, your listings, your relay selections, and your communication preferences. You can clear local browser data at any time, and opt out of non-essential emails via the unsubscribe link. To request access to or deletion of account, order, email, or affiliate records stored on our backend, contact us through the channels below; some records may be retained where required for legal or financial reasons. Note that content published to Nostr relays may persist independently of us.",
    },
    {
      title: "Changes to Privacy Policy",
      content:
        "We may update this policy as the platform evolves — for example, when we add or change hosted features. Material changes will be reflected here along with an updated date at the top of this page. Continued use of Milk Market after an update constitutes acceptance of the revised policy.",
    },
    {
      title: "Contact Information",
      content:
        "For privacy-related questions or data requests, you can reach the Milk Market team through our Nostr channels or GitHub repository.",
    },
  ];

  return (
    <>
      <Head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1"
        />
        <title>Privacy Policy - Milk Market | Data Protection & Privacy</title>
        <meta
          name="description"
          content="Learn how Milk Market handles your data: a decentralized Nostr and Bitcoin core plus a hosted backend for payments, email, and analytics. Read what we store and how it is protected."
        />
        <link rel="apple-touch-icon" href="/milk-market.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/milk-market.png" />
        <meta property="og:type" content="website" />
        <meta
          property="og:title"
          content="Privacy Policy - Milk Market | Data Protection & Privacy"
        />
        <meta
          property="og:description"
          content="Learn how Milk Market handles your data: a decentralized Nostr and Bitcoin core plus a hosted backend for payments, email, and analytics. Read what we store and how it is protected."
        />
        <meta property="og:image" content="/milk-market.png" />
        <meta
          name="twitter:title"
          content="Privacy Policy - Milk Market | Data Protection & Privacy"
        />
        <meta
          name="twitter:description"
          content="Learn how Milk Market handles your data: a decentralized Nostr and Bitcoin core plus a hosted backend for payments, email, and analytics. Read what we store and how it is protected."
        />
        <meta name="twitter:image" content="/milk-market.png" />
        <meta
          name="keywords"
          content="privacy policy, milk market, data protection, nostr privacy, permissionless platform, decentralized marketplace, user privacy"
        />
      </Head>
      {/* Main container with new background pattern */}
      <div className="bg-grid-pattern flex min-h-screen flex-col bg-white py-8 md:pb-20">
        {/* Centered content with a max-width for readability */}
        <div className="container mx-auto max-w-4xl px-4">
          <div className="mb-12">
            {/* Back button with new neo-brutalist style */}
            <button
              onClick={() => router.back()}
              className={`${WHITEBUTTONCLASSNAMES} mb-8 flex items-center gap-2`}
            >
              <span aria-hidden="true" className="text-sm leading-none">
                ⬅️
              </span>
              Back
            </button>
            <h1 className="text-center text-5xl font-bold text-black">
              Privacy Policy
            </h1>
            <p className="mt-4 text-center text-lg text-zinc-600">
              How Milk Market protects your privacy
            </p>
            <p className="mt-2 text-center text-sm text-zinc-500">
              Last updated: 2026-06-06
            </p>
          </div>

          {/* Map through content and create styled cards */}
          <div className="space-y-6">
            {policyContent.map((section) => (
              <div
                key={section.title}
                // Applying the new neo-brutalist card style
                className="shadow-neo rounded-lg border-2 border-black bg-white p-6"
              >
                <h3 className="mb-2 text-lg font-bold text-black">
                  {section.title}
                </h3>
                <p className="leading-relaxed text-zinc-700">
                  {section.content}
                </p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
