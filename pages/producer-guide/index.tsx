import { useState } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import { Button } from "@heroui/react";
import {
  ArrowLeftIcon,
  InformationCircleIcon,
  Bars3Icon,
  PlusIcon,
  VideoCameraIcon,
} from "@heroicons/react/24/outline";
import {
  WHITEBUTTONCLASSNAMES,
  PRIMARYBUTTONCLASSNAMES,
} from "@/utils/STATIC-VARIABLES";

const VideoPlaceholder = () => (
  <div className="relative aspect-video w-full overflow-hidden rounded-lg border-3 border-black bg-gray-700">
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-white">
      <div className="shadow-neo flex h-16 w-16 items-center justify-center rounded-full border-3 border-black bg-white">
        <VideoCameraIcon className="h-8 w-8 text-black" />
      </div>
      <span className="text-sm font-bold">Video coming soon</span>
    </div>
  </div>
);

const ProducerGuidePage = () => {
  const router = useRouter();
  const [openFaqIndex, setOpenFaqIndex] = useState<number | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activeSection, setActiveSection] = useState("introduction");

  const toggleFaq = (index: number) => {
    setOpenFaqIndex(openFaqIndex === index ? null : index);
  };

  const scrollToSection = (sectionId: string) => {
    const element = document.getElementById(sectionId);
    if (element) {
      element.scrollIntoView({ behavior: "smooth" });
      setActiveSection(sectionId);
      setSidebarOpen(false);
    }
  };

  const sidebarItems = [
    {
      id: "introduction",
      label: "Introduction",
      threads: [],
    },
    {
      id: "step-1",
      label: "Step 1: Account",
      threads: [
        { id: "step-1-1", label: "1.1 Sign In Modal" },
        { id: "step-1-2", label: "1.2 Keys Page" },
        { id: "step-1-3", label: "1.3 Profile Page" },
        { id: "step-1-4", label: "1.4 Stall Page" },
      ],
    },
    {
      id: "step-2",
      label: "Step 2: Membership",
      threads: [],
    },
    {
      id: "step-3",
      label: "Step 3: List Product",
      threads: [
        { id: "step-3-1", label: "3.1 Listing Password" },
        { id: "step-3-2", label: "3.2 Product Details" },
        { id: "step-3-3", label: "3.3 Pickup Details" },
        { id: "step-3-4", label: "3.4 List Product" },
      ],
    },
    {
      id: "step-4",
      label: "Step 4: Orders",
      threads: [
        { id: "step-4-1", label: "4.1 Orders Dashboard" },
        { id: "step-4-2", label: "4.2 Fiat Order Chat" },
        { id: "step-4-3", label: "4.3 Bitcoin Order Chat" },
        { id: "step-4-4", label: "4.4 Payment Redemption" },
        { id: "step-4-5", label: "4.5 Wallet Page" },
      ],
    },
    {
      id: "step-5",
      label: "Step 5: Stall",
      threads: [],
    },
    {
      id: "step-6",
      label: "Step 6: Self-Host",
      threads: [],
    },
    {
      id: "step-7",
      label: "Step 7: Email Flows",
      threads: [],
    },
    {
      id: "step-8",
      label: "Step 8: AI Agents (MCP)",
      threads: [],
    },
    {
      id: "step-9",
      label: "Step 9: Grow",
      threads: [
        { id: "step-9-1", label: "9.1 Update Listings" },
        { id: "step-9-2", label: "9.2 Build Relationships" },
        { id: "step-9-3", label: "9.3 Share Story" },
        { id: "step-9-4", label: "9.4 Network Growth" },
      ],
    },
  ];

  const faqItems = [
    {
      id: "passphrase-faq",
      question: "What is a passphrase? What is it used for?",
      answer:
        "A passphrase is just a password you create as a user to keep your private key stored safely in your browser so only you can access your account. It is needed for securely sending messages, listing products, or saving profile and stall information on Milk Market.",
    },
    {
      id: "payment-methods-faq",
      question: "What payment methods do customers use?",
      answer: (
        <>
          Milk Market supports Bitcoin payments through Lightning Network and
          Cashu tokens, as well as credit and debit card payments via Stripe.
          You can also arrange cash payments directly with customers during
          pickup or delivery and other payment options like{" "}
          <a
            href="https://cash.app/bitcoin"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-yellow underline hover:opacity-80"
          >
            Cash App
          </a>
          , Venmo, PayPal, etc.
        </>
      ),
    },
    {
      id: "bitcoin-faq",
      question: "Why Bitcoin? How can I exchange it?",
      answer: (
        <>
          <a
            href="https://bitcoin.rocks/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-yellow underline hover:opacity-80"
          >
            Bitcoin
          </a>{" "}
          is supported because it allows for complete control over your funds
          and transactions and protects your wealth over time. Payment
          processors like Stripe, PayPal, etc. can freeze your funds, close your
          account, or even ban you for selling products they don&apos;t deem
          acceptable (which local food like raw milk and dairy can easily fall
          under). If desired, you can exchange it for cash or other currencies
          at your own pace using tools like{" "}
          <a
            href="https://cash.app/bitcoin"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-yellow underline hover:opacity-80"
          >
            Cash App
          </a>{" "}
          or{" "}
          <a
            href="https://strike.me/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-yellow underline hover:opacity-80"
          >
            Strike
          </a>
          .
        </>
      ),
    },
    {
      id: "listing-passphrase-faq",
      question: "What is the listing passphrase? How do I get it?",
      answer:
        "The listing passphrase is a password set by Milk Market to prevent spam and ensure that trusted producers can list products. You can get it by contacting Milk Market or other producers in the Milk Market community.",
    },
    {
      id: "process-payments-faq",
      question: "How do I process payments?",
      answer: (
        <>
          If accepting Bitcoin payments, you can redeem them through the orders
          dashboard and directly to the site wallet. With the wallet, you can
          save your payments or send money to another wallet like{" "}
          <a
            href="https://cash.app/bitcoin"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-yellow underline hover:opacity-80"
          >
            Cash App
          </a>
          ,{" "}
          <a
            href="https://coinos.io/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-yellow underline hover:opacity-80"
          >
            Coinos
          </a>
          ,{" "}
          <a
            href="https://www.minibits.cash/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary-yellow underline hover:opacity-80"
          >
            Minibits
          </a>
          , etc. If accepting cash, you can arrange payment during pickup or
          delivery. With other online fiat options, payment should be delivered
          with the order to the specified account, so make sure to check your
          external accounts for any incoming payments.
        </>
      ),
    },
    {
      id: "sales-tax-faq",
      question: "Can I collect sales tax on card orders?",
      answer:
        "Yes. If you've connected a Stripe account, you can turn on automatic sales tax from Settings → Payments. Once enabled and you've added the US states where you're registered, Stripe calculates the correct sales tax from each buyer's shipping address and shows it at checkout on card orders. It's free to use and available to every Stripe-connected seller.",
    },
    {
      id: "delivery-faq",
      question: "How do I handle delivery and pickup?",
      answer:
        "You set your own delivery options - whether you offer farm pickup, local delivery, or meet at farmers markets. Coordinate specific details on your product details page or through the encrypted messaging system with each customer.",
    },
    {
      id: "privacy-faq",
      question: "Is my communication with customers private?",
      answer:
        "Yes, all messages are encrypted. Only you and your customers can see your conversations - no third parties have access to your private communications.",
    },
  ];

  return (
    <>
      <Head>
        <title>Producer Guide: How to Sell on Milk Market</title>
        <meta
          name="description"
          content="Step-by-step guide for producers selling raw milk, dairy, meat, eggs, and local food on Milk Market. Learn how to set up your account, list products, accept payments, and grow your stall."
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "HowTo",
              name: "How to Sell on Milk Market",
              description:
                "A step-by-step guide for producers to set up their account, list products, accept payments, and grow their stall on Milk Market.",
              url: "https://milk.market/producer-guide",
              step: [
                {
                  "@type": "HowToStep",
                  name: "Create Your Account",
                  text: "Sign up for Milk Market using your Nostr identity or create a new one. Complete the onboarding process and set up your user profile with payment preferences.",
                  url: "https://milk.market/producer-guide#step-1",
                },
                {
                  "@type": "HowToStep",
                  name: "Choose Your Membership",
                  text: "Selling is free with unlimited listings and no mandatory transaction fees. Milk Market never adds a fee of its own. Bitcoin payments have no fees at all, and if you accept cards through Stripe, Stripe charges its own standard processing fee. Upgrade to Herd ($21/month) for custom domains, advanced stall design, automated email flows with open/click/conversion analytics, and AI agent access.",
                  url: "https://milk.market/producer-guide#step-2",
                },
                {
                  "@type": "HowToStep",
                  name: "List Your Products",
                  text: "Use the listing password to create product listings. Add details like name, description, price, photos, and pickup or delivery options.",
                  url: "https://milk.market/producer-guide#step-3",
                },
                {
                  "@type": "HowToStep",
                  name: "Manage Orders",
                  text: "Receive and process orders through the orders dashboard. Accept Bitcoin payments via Lightning or Cashu, card payments via Stripe, or arrange cash transactions directly with customers.",
                  url: "https://milk.market/producer-guide#step-4",
                },
                {
                  "@type": "HowToStep",
                  name: "Customize Your Stall",
                  text: "Personalize your public stall with colors, fonts, banners, and page sections so buyers can browse your products with a branded experience.",
                  url: "https://milk.market/producer-guide#step-5",
                },
                {
                  "@type": "HowToStep",
                  name: "Self-Host Your Store",
                  text: "On the Wrangler lifetime plan, run your own single-tenant copy of Milk Market on your own server, with your own Stripe account, no platform fees, and no marketplace chrome, so buyers only ever see your brand.",
                  url: "https://milk.market/producer-guide#step-6",
                },
                {
                  "@type": "HowToStep",
                  name: "Set Up Email Flows",
                  text: "Configure automated email sequences to onboard new customers, confirm orders, and keep buyers engaged with your farm or shop. Track opens, clicks, and conversions for every flow and one-time send.",
                  url: "https://milk.market/producer-guide#step-7",
                },
                {
                  "@type": "HowToStep",
                  name: "Enable AI Agent (MCP) Access",
                  text: "Activate the Model Context Protocol endpoint so AI agents can manage your stall (creating and updating listings, tracking inventory, and handling orders), and so agentic shopping tools can discover and purchase from your stall automatically.",
                  url: "https://milk.market/producer-guide#step-8",
                },
                {
                  "@type": "HowToStep",
                  name: "Grow Your Business",
                  text: "Regularly update your listings, engage with customers, share your story and growing practices, and leverage the Milk Market community to expand your reach.",
                  url: "https://milk.market/producer-guide#step-9",
                },
              ],
            }),
          }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              "@context": "https://schema.org",
              "@type": "FAQPage",
              mainEntity: [
                {
                  "@type": "Question",
                  name: "What is a passphrase? What is it used for?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "A passphrase is just a password you create as a user to keep your private key stored safely in your browser so only you can access your account. It is needed for securely sending messages, listing products, or saving profile and stall information on Milk Market.",
                  },
                },
                {
                  "@type": "Question",
                  name: "What payment methods do customers use?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Milk Market supports Bitcoin payments through Lightning Network and Cashu tokens, as well as credit and debit card payments via Stripe. You can also arrange cash payments directly with customers during pickup or delivery and other payment options like Cash App, Venmo, PayPal, etc.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Why Bitcoin? How can I exchange it?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Bitcoin is supported because it allows for complete control over your funds and transactions and protects your wealth over time. Payment processors like Stripe, PayPal, etc. can freeze your funds, close your account, or even ban you for selling products they don't deem acceptable (which local food like raw milk can easily fall under). If desired, you can exchange it for cash or other currencies at your own pace using tools like Cash App or Strike.",
                  },
                },
                {
                  "@type": "Question",
                  name: "What is the listing passphrase? How do I get it?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "The listing passphrase is a password set by Milk Market to prevent spam and ensure that trusted producers can list products. You can get it by contacting Milk Market or other producers in the Milk Market community.",
                  },
                },
                {
                  "@type": "Question",
                  name: "How do I process payments?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "If accepting Bitcoin payments, you can redeem them through the orders dashboard and directly to the site wallet. With the wallet, you can save your payments or send money to another wallet like Cash App, Coinos, Minibits, etc. If accepting cash, you can arrange payment during pickup or delivery. With other online fiat options, payment should be delivered with the order to the specified account.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Can I collect sales tax on card orders?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Yes. If you've connected a Stripe account, you can turn on automatic sales tax from Settings → Payments. Once enabled and you've added the US states where you're registered, Stripe calculates the correct sales tax from each buyer's shipping address and shows it at checkout on card orders. It's free to use and available to every Stripe-connected seller.",
                  },
                },
                {
                  "@type": "Question",
                  name: "How do I handle delivery and pickup?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "You set your own delivery options - whether you offer farm pickup, local delivery, or meet at farmers markets. Coordinate specific details on your product details page or through the encrypted messaging system with each customer.",
                  },
                },
                {
                  "@type": "Question",
                  name: "Is my communication with customers private?",
                  acceptedAnswer: {
                    "@type": "Answer",
                    text: "Yes, all messages are encrypted. Only you and your customers can see your conversations - no third parties have access to your private communications.",
                  },
                },
              ],
            }),
          }}
        />
      </Head>
      <div className="min-h-screen bg-white">
        {/* Mobile Sidebar Toggle */}
        <button
          className="shadow-neo fixed top-4 right-4 z-50 rounded border-2 border-black bg-white p-2 lg:hidden"
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <Bars3Icon className="h-6 w-6 text-black" />
        </button>

        {/* Sidebar */}
        <aside
          className={`shadow-neo fixed top-0 left-0 z-40 h-screen w-64 transform border-r-4 border-black bg-white transition-transform lg:translate-x-0 ${
            sidebarOpen ? "translate-x-0" : "-translate-x-full"
          }`}
        >
          <div className="h-full overflow-y-auto p-6">
            <h2 className="mb-6 text-2xl font-bold text-black">Guide</h2>
            <nav className="space-y-2">
              {sidebarItems.map((item) => (
                <div key={item.id}>
                  <button
                    onClick={() => scrollToSection(item.id)}
                    className={`w-full rounded border-2 border-black px-4 py-2 text-left font-bold transition-all hover:-translate-y-0.5 ${
                      activeSection === item.id
                        ? "bg-primary-yellow shadow-neo text-black"
                        : "bg-white text-black"
                    }`}
                  >
                    {item.label}
                  </button>
                  {item.threads.length > 0 && (
                    <div className="mt-2 ml-4 space-y-1">
                      {item.threads.map((thread) => (
                        <button
                          key={thread.id}
                          onClick={() => scrollToSection(thread.id)}
                          className={`w-full rounded px-3 py-1 text-left text-sm transition-all hover:bg-gray-100 ${
                            activeSection === thread.id
                              ? "text-primary-blue font-bold"
                              : "text-black"
                          }`}
                        >
                          {thread.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </nav>
          </div>
        </aside>

        {/* Overlay for mobile */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-30 bg-black/50 lg:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Main Content */}
        <div className="lg:ml-64">
          <div className="mx-auto max-w-5xl px-4 py-8">
            {/* Header */}
            <div id="introduction" className="mb-12">
              <Button
                className={`mb-8 ${WHITEBUTTONCLASSNAMES}`}
                onClick={() => router.push("/")}
                startContent={<ArrowLeftIcon className="h-4 w-4" />}
              >
                Home
              </Button>

              <div className="text-center">
                <h1 className="mb-4 text-5xl font-bold text-black">
                  Producer Guide
                </h1>
                <p className="text-primary-blue mx-auto max-w-3xl text-lg">
                  Learn how to start selling your local food and goods on Milk
                  Market &mdash; from raw milk and dairy to meat, eggs, produce,
                  baked goods, honey, and handmade goods.
                </p>
              </div>
            </div>

            {/* Step-by-Step Guide */}
            <div className="space-y-8">
              {/* Step 1 */}
              <div
                id="step-1"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="mb-6 flex items-start gap-4">
                  <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                    1
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-2 text-2xl font-bold text-white">
                      Create Your Account
                    </h3>
                    <p className="mb-4 text-base text-white">
                      Sign up for Milk Market using your Nostr identity or
                      create a new one. Your Nostr key ensures secure, private
                      communication with customers.
                    </p>
                    <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                      <li id="step-1-1">
                        Click &ldquo;Sign In&rdquo; in the top navigation
                      </li>
                      <li id="step-1-2">
                        Choose your preferred login method or create a new
                        account{" "}
                        <span className="inline-flex items-center">
                          with a passphrase{" "}
                          <InformationCircleIcon
                            className="text-primary-yellow ml-1 h-4 w-4 cursor-pointer hover:opacity-80"
                            onClick={() => {
                              const faqSection =
                                document.getElementById("passphrase-faq");
                              if (faqSection) {
                                faqSection.scrollIntoView({
                                  behavior: "smooth",
                                });
                              }
                            }}
                          />
                        </span>
                      </li>
                      <li id="step-1-3">Complete the onboarding process</li>
                      <li id="step-1-4">
                        Set up your user profile with basic information,
                        including{" "}
                        <span className="inline-flex items-center">
                          payment preferences{" "}
                          <InformationCircleIcon
                            className="text-primary-yellow ml-1 h-4 w-4 cursor-pointer hover:opacity-80"
                            onClick={() => {
                              const faqSection = document.getElementById(
                                "payment-methods-faq"
                              );
                              if (faqSection) {
                                faqSection.scrollIntoView({
                                  behavior: "smooth",
                                });
                              }
                            }}
                          />
                        </span>
                      </li>
                    </ul>
                  </div>
                </div>

                {/* Video Placeholder */}
                <VideoPlaceholder />
              </div>

              {/* Step 2 */}
              <div
                id="step-2"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
                  <div className="flex items-start gap-4 lg:flex-1">
                    <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                      2
                    </div>
                    <div className="flex-1">
                      <h3 className="mb-2 text-2xl font-bold text-white">
                        Choose Your Membership
                      </h3>
                      <p className="mb-4 text-base text-white">
                        Selling is free with unlimited listings and no mandatory
                        transaction fees. Upgrade to Herd whenever you want a
                        fully custom stall and pro tools.
                      </p>
                      <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                        <li>
                          Start free with unlimited listings, your seller
                          profile, Stripe payouts, discount codes, and affiliate
                          tools
                        </li>
                        <li>
                          Go Herd for $21/month (or $168/year, saving 33%) to
                          unlock advanced stalls, custom domains, email flows
                          with open/click analytics, custom product pages,
                          shipping labels, and AI agent (MCP) access &mdash; or
                          go Wrangler for one-time $2,100 lifetime access
                        </li>
                        <li>
                          New sellers get a 30-day free trial of Herd with no
                          payment required up front
                        </li>
                        <li>
                          We&apos;ll remind you to pay for your selected plan
                          before the trial ends &mdash; you can stay on free
                          anytime
                        </li>
                      </ul>
                    </div>
                  </div>
                  <div className="flex items-center justify-center lg:w-1/2">
                    <VideoPlaceholder />
                  </div>
                </div>
              </div>

              {/* Step 3 */}
              <div
                id="step-3"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="mb-6 flex items-start gap-4">
                  <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                    3
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-2 text-2xl font-bold text-white">
                      List Your First Product
                    </h3>
                    <p className="mb-4 text-base text-white">
                      Create detailed product listings that showcase your
                      products and attract customers.
                    </p>
                    <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                      <li id="step-3-1">
                        Navigate to &ldquo;My Listings&rdquo; and click
                        &ldquo;Add Product&rdquo;
                      </li>
                      <li id="step-3-2">
                        Enter the listing passphrase{" "}
                        <span className="inline-flex items-center">
                          if this is your first product{" "}
                          <InformationCircleIcon
                            className="text-primary-yellow ml-1 h-4 w-4 cursor-pointer hover:opacity-80"
                            onClick={() => {
                              const faqSection = document.getElementById(
                                "listing-passphrase-faq"
                              );
                              if (faqSection) {
                                faqSection.scrollIntoView({
                                  behavior: "smooth",
                                });
                              }
                            }}
                          />
                        </span>
                      </li>
                      <li id="step-3-3">Upload clear product photos</li>
                      <li id="step-3-4">
                        Write detailed descriptions and set pricing and/or
                        volume pricing
                      </li>
                      <li>Specify delivery options</li>
                      <li>Publish your listing to the marketplace</li>
                    </ul>
                  </div>
                </div>

                {/* Video Placeholder */}
                <VideoPlaceholder />
              </div>

              {/* Step 4 */}
              <div
                id="step-4"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="mb-6 flex items-start gap-4">
                  <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                    4
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-2 text-2xl font-bold text-white">
                      Manage Orders & Communication
                    </h3>
                    <p className="mb-4 text-base text-white">
                      Handle customer inquiries and orders through our encrypted
                      messaging system.
                    </p>
                    <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                      <li id="step-4-1">
                        Monitor the &ldquo;Orders&rdquo; section for new
                        messages
                      </li>
                      <li id="step-4-2">
                        Respond promptly to customer inquiries
                      </li>
                      <li id="step-4-3">Coordinate pickup/delivery details</li>
                      <li id="step-4-4">
                        Process payments{" "}
                        <span className="inline-flex items-center">
                          according to your preferences{" "}
                          <InformationCircleIcon
                            className="text-primary-yellow ml-1 h-4 w-4 cursor-pointer hover:opacity-80"
                            onClick={() => {
                              const faqSection = document.getElementById(
                                "process-payments-faq"
                              );
                              if (faqSection) {
                                faqSection.scrollIntoView({
                                  behavior: "smooth",
                                });
                              }
                            }}
                          />
                        </span>
                      </li>
                    </ul>
                  </div>
                </div>

                {/* Video Placeholder */}
                <VideoPlaceholder />
              </div>

              {/* Step 5 */}
              <div
                id="step-5"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="flex items-start gap-4">
                  <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                    5
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-2 text-2xl font-bold text-white">
                      Customize Your Stall
                      <span className="shadow-neo bg-primary-yellow ml-2 inline-block rounded border-2 border-black px-2 py-0.5 align-middle text-xs font-bold text-black">
                        Pro
                      </span>
                    </h3>
                    <p className="mb-4 text-base text-white">
                      Make your stall your own with a fully branded design that
                      you control.
                    </p>
                    <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                      <li>Pick your own colors, fonts, and theme</li>
                      <li>
                        Arrange your shop with the page builder and custom
                        product pages
                      </li>
                      <li>Connect your own custom domain (self-serve)</li>
                      <li>
                        Set your SEO and social sharing (OpenGraph) previews
                      </li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Step 6 */}
              <div
                id="step-6"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="flex items-start gap-4">
                  <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                    6
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-2 text-2xl font-bold text-white">
                      Self-Host Your Store
                      <span className="shadow-neo bg-primary-yellow ml-2 inline-block rounded border-2 border-black px-2 py-0.5 align-middle text-xs font-bold text-black">
                        Wrangler
                      </span>
                    </h3>
                    <p className="mb-4 text-base text-white">
                      Want full control? On the Wrangler lifetime plan you can
                      run your own copy of Milk Market on your own server.
                    </p>
                    <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                      <li>Run a single-tenant store that&apos;s just yours</li>
                      <li>
                        Take card payments through your own Stripe account, with
                        no platform fees
                      </li>
                      <li>
                        Drop the marketplace chrome so buyers only ever see your
                        brand
                      </li>
                      <li>
                        Export a ready-to-deploy setup bundle and host it
                        yourself
                      </li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Step 7 */}
              <div
                id="step-7"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="flex items-start gap-4">
                  <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                    7
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-2 text-2xl font-bold text-white">
                      Automate Your Email Flows
                      <span className="shadow-neo bg-primary-yellow ml-2 inline-block rounded border-2 border-black px-2 py-0.5 align-middle text-xs font-bold text-black">
                        Pro
                      </span>
                    </h3>
                    <p className="mb-4 text-base text-white">
                      Stay in touch with buyers automatically so you never miss
                      a follow-up.
                    </p>
                    <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                      <li>
                        Send automated welcome, follow-up, and re-engagement
                        emails
                      </li>
                      <li>
                        Build multi-step flows that trigger on customer actions
                      </li>
                      <li>Customize the copy and timing for each message</li>
                      <li>
                        Track opens, clicks, top links, and conversions in the
                        Email Stats dashboard
                      </li>
                      <li>
                        Your analytics are private to your account. Every
                        request is scoped to you, so no other seller (and not
                        the platform) can see them
                      </li>
                      <li>
                        Unsubscribe handling is built in for every contact
                      </li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Step 8 */}
              <div
                id="step-8"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="flex items-start gap-4">
                  <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                    8
                  </div>
                  <div className="flex-1">
                    <h3 className="mb-2 text-2xl font-bold text-white">
                      Connect AI Agents with MCP
                      <span className="shadow-neo bg-primary-yellow ml-2 inline-block rounded border-2 border-black px-2 py-0.5 align-middle text-xs font-bold text-black">
                        Pro
                      </span>
                    </h3>
                    <p className="mb-4 text-base text-white">
                      Connect AI agents to your stall through the Model Context
                      Protocol (MCP) API to run your stall with AI, and open it
                      up to AI shopping agents.
                    </p>
                    <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                      <li>
                        Create API keys with read, purchase, or write permission
                        levels
                      </li>
                      <li>
                        Manage your stall with AI to create and update listings,
                        track inventory, and handle orders
                      </li>
                      <li>
                        Let shopping agents browse your listings and check live
                        inventory
                      </li>
                      <li>
                        Enable agentic checkout so AI buyers can purchase
                        directly
                      </li>
                      <li>Manage and revoke access anytime from settings</li>
                    </ul>
                  </div>
                </div>
              </div>

              {/* Step 9 */}
              <div
                id="step-9"
                className="bg-primary-blue shadow-neo rounded-lg border-4 border-black p-6"
              >
                <div className="flex flex-col gap-6 lg:flex-row lg:items-center">
                  <div className="flex items-start gap-4 lg:flex-1">
                    <div className="shadow-neo flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border-4 border-black bg-white text-2xl font-bold text-black">
                      9
                    </div>
                    <div className="flex-1">
                      <h3 className="mb-2 text-2xl font-bold text-white">
                        Grow Your Business
                      </h3>
                      <p className="mb-4 text-base text-white">
                        Build your customer base and expand your reach within
                        the Milk Market community.
                      </p>
                      <ul className="list-disc space-y-2 pl-6 text-sm text-white">
                        <li id="step-9-1">
                          Regularly update your product listings
                        </li>
                        <li id="step-9-2">
                          Engage with customers and build relationships
                        </li>
                        <li id="step-9-3">
                          Share your story and growing practices
                        </li>
                        <li id="step-9-4">Leverage the Milk Market network</li>
                      </ul>
                    </div>
                  </div>
                  <div className="flex items-center justify-center lg:w-1/2">
                    <VideoPlaceholder />
                  </div>
                </div>
              </div>
            </div>

            {/* FAQ Section */}
            <div className="shadow-neo mt-16 rounded-lg border-4 border-black bg-[#2c3e50] p-8">
              <h2 className="mb-6 text-center text-2xl font-bold text-white">
                New Producer FAQ
              </h2>
              <div className="space-y-0">
                {faqItems.map((item, index) => (
                  <div
                    key={index}
                    id={item.id}
                    className="border-b border-white/20 last:border-b-0"
                  >
                    <button
                      onClick={() => toggleFaq(index)}
                      className="flex w-full items-center justify-between py-4 text-left text-white transition-colors hover:opacity-80"
                    >
                      <h3 className="pr-4 text-base font-normal">
                        {item.question}
                      </h3>
                      <PlusIcon
                        className={`h-6 w-6 flex-shrink-0 transition-transform ${
                          openFaqIndex === index ? "rotate-45" : ""
                        }`}
                      />
                    </button>
                    <div
                      className={`bg-white/10 px-4 pt-2 pb-4 ${
                        openFaqIndex === index ? "" : "hidden"
                      }`}
                    >
                      <p className="text-sm leading-relaxed text-white/90">
                        {item.answer}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Call to Action */}
            <div className="bg-primary-blue shadow-neo mt-16 rounded-lg border-4 border-black p-6 text-center">
              <h2 className="mb-3 text-2xl font-bold text-white">
                Ready to Start Selling?
              </h2>
              <p className="mb-6 text-base text-white">
                Join the growing community of producers providing fresh, local
                food &mdash; from raw milk and dairy to meat, eggs, and produce
                &mdash; directly to consumers. Selling is free with unlimited
                listings, and new sellers get a 30-day free trial of Herd
                &mdash; no payment required up front.
              </p>
              <div className="flex flex-col items-center justify-center gap-4 sm:flex-row">
                <Button
                  className={PRIMARYBUTTONCLASSNAMES}
                  onClick={() => router.push("/marketplace")}
                >
                  Free Milk
                </Button>
                <Button
                  className={WHITEBUTTONCLASSNAMES}
                  onClick={() => router.push("/faq")}
                >
                  View General FAQ
                </Button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};

export default ProducerGuidePage;
