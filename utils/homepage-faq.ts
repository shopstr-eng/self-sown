export interface FaqItem {
  question: string;
  answer: string;
}

export const HOMEPAGE_FAQ: FaqItem[] = [
  {
    question: "What can I sell on Self-sown?",
    answer:
      "Food producers and local artisans can sell almost anything they make - produce, meat and eggs, dairy, baked goods, preserves, honey, herdshares, and handmade goods. You set your own prices, pickup, delivery, and payment methods.",
  },
  {
    question: "How much does it cost to sell?",
    answer:
      "Starting is free, with unlimited listings and no mandatory transaction fees, ever. Self-sown never adds a fee of its own. Bitcoin payments have no fees at all, and if you choose to accept cards through Stripe or Square, that processor charges its own standard processing fee. Herd is $21/month (or $168/year) and adds custom domains, advanced stall design, automated email flows, shipping labels, AI agent (MCP) access, and an in-app AI seller assistant that can manage your stall through chat. Prefer to pay once? Wrangler is a one-time $2,100 purchase for lifetime access to every Herd feature. New sellers get a 30-day free trial of Herd, with no payment required up front. You can set an optional donation rate to support the platform, but that's always your choice.",
  },
  {
    question: "What happens if Self-sown shuts down or removes my account?",
    answer:
      "Your stall survives it. Self-sown is built on Nostr, an open and decentralized network, so your listings, profile, and customer relationships live on public relays under your own keys - not in a single company's database. No one can freeze your account or deplatform you, and you can take your identity to any other Nostr-compatible marketplace.",
  },
  {
    question: "How do payments work?",
    answer:
      "Buyers can pay with a card, Bitcoin (Lightning and Cashu ecash), or cash for local pickup. Sellers connect their own payout method and get paid directly - there's no middleman holding your money.",
  },
  {
    question: "Is my information private?",
    answer:
      "Messages between buyers and sellers are end-to-end encrypted (Nostr NIP-17), so we can't read them, and you can browse and sell under a pseudonymous Nostr key. Some things are stored on our servers to make the marketplace work - like the email and shipping address needed to fulfill an order - and payments, email, and shipping are handled by processors (Stripe or Square, SendGrid, Shippo) under their own privacy policies. We never sell user data. The full breakdown is in our Privacy Policy.",
  },
  {
    question: "I'm already on Shopify or Barn2Door. Can I switch?",
    answer:
      "Yes. You can migrate from Shopify in a few clicks and keep your products. Click 'Start Selling' or 'Migrate from Shopify' to bring your catalog over and open your stall in minutes.",
  },
];
