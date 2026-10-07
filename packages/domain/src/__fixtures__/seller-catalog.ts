import type { NostrEventRecord } from "../seller";

/** Synthetic public products; never use real seller data in these fixtures. */
export function catalogEvent(
  tags: string[][] = []
): NostrEventRecord & { sig: string } {
  return {
    id: "1".repeat(64),
    pubkey: "a".repeat(64),
    kind: 30402,
    created_at: 1700000000,
    content: "Farm milk",
    sig: "b".repeat(128),
    tags: [
      ["d", "farm-milk"],
      ["title", "Farm milk"],
      ["summary", "Farm milk"],
      ["price", "12", "USD"],
      ["image", "https://example.com/milk.jpg"],
      ["location", "Farm"],
      ["t", "Milk"],
      ["shipping", "Free", "0", "USD"],
      ...tags,
    ],
  };
}
export const catalogOptionTags = [
  ["size", "SM", "0"],
  ["size", "LG", "4"],
  ["volume", "Quart", "12"],
  ["volume", "Gallon", "40"],
  ["weight", "1lbs", "18"],
  ["variant_label", "Flavor"],
  ["variant", "Plain"],
  ["variant", "Vanilla", "https://example.com/vanilla.jpg"],
  ["variant_display", "dropdown"],
  ["bulk", "3", "30", "Quart"],
];
export const catalogPreservedTags = [
  ["subscription", "true"],
  ["subscription_discount", "10"],
  ["subscription_frequency", "weekly"],
  ["herdshare", "https://example.com/agreement.pdf"],
  ["required", "Contact"],
  ["restrictions", "Local delivery"],
  ["expiration", "1900000000"],
  ["lab_report", "https://example.com/lab.pdf", "Report"],
  ["page", '{"layout":"classic"}'],
  ["custom", "untouched", "extra"],
];
