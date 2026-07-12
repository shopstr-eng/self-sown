export interface FaqItem {
  question: string;
  answer: string;
}

export const HOMEPAGE_FAQ: FaqItem[] = [
  {
    question: "What can I sell on Milk Market?",
    answer:
      "Food producers and local artisans can sell almost anything they make - raw milk and dairy, meat and eggs, produce, baked goods, preserves, honey, herdshares, and handmade goods. You set your own prices, pickup, delivery, and payment methods.",
  },
  {
    question: "How much does it cost to sell?",
    answer:
      "Starting is free, with unlimited listings and no mandatory transaction fees, ever. Milk Market never adds a fee of its own. Bitcoin payments have no fees at all, and if you choose to accept cards through Stripe or Square, that processor charges its own standard processing fee. Herd is $21/month (or $168/year) and adds custom domains, advanced stall design, automated email flows, shipping labels, and AI agent (MCP) access. Prefer to pay once? Wrangler is a one-time $2,100 purchase for lifetime access to every Herd feature. New sellers get a 30-day free trial of Herd, with no payment required up front. You can set an optional donation rate to support the platform, but that's always your choice.",
  },
  {
    question: "What happens if Milk Market shuts down or removes my account?",
    answer:
      "Yes. Milk Market is built on Nostr, an open and decentralized network. Your stall and customer relationships belong to you - not a single company. No one can freeze your account or deplatform you.",
  },
  {
    question: "How do payments work?",
    answer:
      "Buyers can pay with a card, Bitcoin (Lightning and Cashu ecash), or cash for local pickup. Sellers connect their own payout method and get paid directly - there's no middleman holding your money.",
  },
  {
    question: "Is my information private?",
    answer:
      "Yes. All your data is encrypted and private. We never sell user data or share it with third parties. The platform is built on Nostr, a decentralized protocol designed for privacy and ownership.",
  },
  {
    question: "I'm already on Shopify or Barn2Door. Can I switch?",
    answer:
      "Yes. You can migrate from Shopify in a few clicks and keep your products. Click 'Start Selling' or 'Migrate from Shopify' to bring your catalog over and open your stall in minutes.",
  },
];
