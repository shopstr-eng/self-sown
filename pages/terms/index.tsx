import { useRouter } from "next/router";
import { WHITEBUTTONCLASSNAMES } from "@/utils/STATIC-VARIABLES";

export default function Tos() {
  const router = useRouter();
  const tosContent = [
    {
      title: "1. Platform Nature",
      content:
        "Milk Market is a permissionless marketplace built on the Nostr and Bitcoin protocols. We do not hold custody of your funds or products, and we are not a party to the transactions between buyers and sellers. To operate the marketplace, however, we run hosted infrastructure — including a caching backend, card-payment processing, and email delivery — described in Section 2 and in our Privacy Policy. We provide the platform and these supporting services, but commerce itself remains peer-to-peer.",
    },
    {
      title: "2. Platform Services & Data",
      content:
        "Alongside the decentralized protocols, we operate a hosted backend that caches public Nostr data for performance and stores account, payment, order, email, storefront, affiliate, and analytics records to power optional features. Card payments are handled by Stripe, transactional and lifecycle emails are delivered through SendGrid, and we collect basic server-side analytics. By using these features you consent to this processing. Our Privacy Policy explains in detail what is stored, what stays end-to-end encrypted, and your choices.",
    },
    {
      title: "3. Relay Selection",
      content:
        "Users have complete control over which Nostr relays they connect to and consequently which products they see. Milk Market does not control the content available on various relays. Users are responsible for configuring their relay connections according to their preferences and local regulations.",
    },
    {
      title: "4. User Responsibilities",
      content:
        "Users must maintain the security of their private keys and wallets, understand that transactions are irreversible, verify seller details before purchasing, and comply with local regulations regarding commerce, imports, and taxation. Vendors are responsible for the accuracy of their listings and legal compliance of their products.",
    },
    {
      title: "5. Prohibited Items",
      content:
        "Though Milk Market has no technical ability to prevent listings, users agree not to list or sell illegal goods or services, harmful substances, counterfeit items, stolen property, or any items that violate applicable laws. The community-based nature of Nostr allows users to choose relays that align with their values.",
    },
    {
      title: "6. Transaction Risks",
      content:
        "Users acknowledge that peer-to-peer transactions carry inherent risks including but not limited to: potential for scams, misrepresented items, shipping complications, and payment processing issues. Milk Market cannot intervene in disputes between buyers and sellers.",
    },
    {
      title: "7. Listing Guidelines",
      content:
        "Listings should contain accurate descriptions, clear images, precise pricing information, and transparent shipping details. Vendors are encouraged to respond promptly to inquiries and maintain professional communication standards.",
    },
    {
      title: "8. Technical Requirements",
      content:
        "A compatible Bitcoin Lightning wallet and/or Cashu implementation is required for transactions. Nostr key pair needed for authentication and encrypted communication. Users must ensure adequate network fees for transactions and maintain reliable internet connectivity.",
    },
    {
      title: "9. Disclaimers",
      content:
        "Milk Market is not a custodial service, cannot guarantee product quality or seller reliability, cannot reverse blockchain transactions, and is not responsible for user errors or losses resulting from key mismanagement. Due to the decentralized nature of the platform, Milk Market cannot remove listings from Nostr relays.",
    },
    {
      title: "10. Dispute Resolution",
      content:
        "Any disputes must be resolved directly between buyers and sellers. We encourage users to communicate clearly and honestly. The platform's review system helps create accountability in the marketplace, but Milk Market cannot enforce resolutions or provide refunds.",
    },
    {
      title: "11. Herd & Wrangler Memberships",
      content:
        "Selling on Milk Market is free with unlimited listings and no mandatory transaction fees. The optional Herd plan unlocks advanced features (advanced storefront customization, self-serve custom domains, automated email flows with engagement analytics that you can send from your own authenticated email domain, custom product pages, shipping labels, and AI agent/MCP access) for $21/month or $168/year. The Wrangler plan is a one-time $2,100 purchase that grants lifetime access to every Herd feature and never expires. New sellers receive a 30-day free trial of Herd with no payment required up front; we will remind you to pay for your selected plan before the trial ends. Paid Herd plans renew automatically until cancelled, and you can downgrade to the free plan at any time. Payments are processed by Stripe or by Bitcoin/manual invoice and are non-refundable except where required by law. Engagement analytics from your email flows are private to your seller account: every request is scoped to your own account so no other seller can see them, and we do not access or use an individual seller's raw email analytics for our own purposes — even though we operate our own storefront on the marketplace as an ordinary seller.",
    },
    {
      title: "12. Modifications",
      content:
        "These terms may be updated periodically. Users are responsible for reviewing changes. Continued use of Milk Market constitutes acceptance of current terms.",
    },
    {
      title: "13. Contact",
      content:
        "Questions about these terms can be addressed through our Nostr channels or GitHub repository.",
    },
  ];

  return (
    <>
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
              Terms of Service
            </h1>
            <p className="mt-4 text-center text-lg text-zinc-600">
              User agreement and usage guidelines for Milk Market
            </p>
            <p className="mt-2 text-center text-sm text-zinc-500">
              Last updated: 2026-06-06
            </p>
          </div>

          {/* Map through content and create styled cards */}
          <div className="space-y-6">
            {tosContent.map((section) => (
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
