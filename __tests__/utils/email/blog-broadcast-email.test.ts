/** @jest-environment node */

import { buildBlogBroadcastEmail } from "@/utils/email/blog-broadcast-email";
import type { BlogPost } from "@self-sown/domain";
import { SITE_URL } from "@/utils/site-url";

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
      postUrl: `${SITE_URL}/stall/x/blog/y`,
      shopName: "<img src=x onerror=alert(1)>",
      unsubscribeUrl: `${SITE_URL}/api/email/unsubscribe?token=z`,
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
      postUrl: `${SITE_URL}/stall/x/blog/y`,
      shopName: "My Shop",
      unsubscribeUrl: `${SITE_URL}/api/email/unsubscribe?token=z`,
    });
    // A non-http(s) image is rejected (no <img> emitted at all).
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("<img");
  });
});

// Captured broadcast fields are mutable JSON: a malformed post row can carry
// numbers/objects where strings are expected. The email must render (with
// coercion/fallback) instead of throwing "x.replace is not a function" and
// silently dropping the whole broadcast batch's email.
describe("buildBlogBroadcastEmail with malformed post fields", () => {
  test("coerces numeric title/summary and drops object-shaped fields", () => {
    let result: { subject: string; html: string } | undefined;
    expect(() => {
      result = buildBlogBroadcastEmail({
        post: post({
          title: 2026,
          summary: { text: "oops" },
          image: 42,
        } as unknown as Partial<BlogPost>),
        postUrl: `${SITE_URL}/stall/x/blog/y`,
        shopName: ["not", "a", "string"] as unknown as string,
        unsubscribeUrl: `${SITE_URL}/api/email/unsubscribe?token=z`,
      });
    }).not.toThrow();

    // Numbers are stringified; objects/arrays collapse to "" — never
    // "[object Object]" — and the object summary emits no empty summary slot.
    expect(result!.subject).toContain("2026");
    expect(result!.html).toContain(">2026</h2>");
    expect(result!.html).not.toContain("[object Object]");
    expect(result!.html).not.toContain("object Object");
    // Non-string image emits no <img> block.
    expect(result!.html).not.toContain("<img");
  });

  test("object-shaped URLs and shop name never reach the HTML raw", () => {
    const { html } = buildBlogBroadcastEmail({
      post: post({ title: "Hi", summary: null as unknown as undefined }),
      postUrl: { href: "javascript:alert(1)" } as unknown as string,
      shopName: 0 as unknown as string,
      unsubscribeUrl: ["x"] as unknown as string,
    });
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).not.toContain("[object Object]");
  });
});
