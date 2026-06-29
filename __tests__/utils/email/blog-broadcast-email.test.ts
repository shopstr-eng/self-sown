/** @jest-environment node */

import { buildBlogBroadcastEmail } from "@/utils/email/blog-broadcast-email";
import type { BlogPost } from "@milk-market/domain";

function post(overrides: Partial<BlogPost> = {}): BlogPost {
  return {
    id: "evt-1",
    pubkey: "a".repeat(64),
    dTag: "post-1",
    title: "Hello",
    content: "body",
    publishedAt: 900,
    updatedAt: 1000,
    hashtags: [],
    ...overrides,
  };
}

describe("buildBlogBroadcastEmail HTML escaping", () => {
  test("escapes attacker-controlled title and shop name everywhere in the HTML, including <title>", () => {
    const { subject, html } = buildBlogBroadcastEmail({
      post: post({
        title: "<script>alert(1)</script>",
        summary: "<b>bold</b> & dangerous",
      }),
      postUrl: "https://milk.market/stall/x/blog/y",
      shopName: "<img src=x onerror=alert(1)>",
      unsubscribeUrl: "https://milk.market/api/email/unsubscribe?token=z",
    });

    // No raw HTML from the permissionless event survives into the rendered body
    // OR the document <title> (the previously-missed escaping site).
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");

    // The plain-text subject is intentionally NOT HTML-escaped — email subjects
    // are not HTML, and escaping would show literal entities in the inbox.
    expect(subject).toContain("<script>alert(1)</script>");
  });

  test("only emits http(s) image and link URLs as attributes", () => {
    const { html } = buildBlogBroadcastEmail({
      post: post({ image: "javascript:alert(1)" }),
      postUrl: "https://milk.market/stall/x/blog/y",
      shopName: "My Shop",
      unsubscribeUrl: "https://milk.market/api/email/unsubscribe?token=z",
    });
    // A non-http(s) image is rejected (no <img> emitted at all).
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("<img");
  });
});
