/** @jest-environment node */

// Unit coverage for the single-blog-post machine-readable builders
// (utils/geo/stall-content.ts): /blog/<slug> content negotiation must return
// the FULL article body (not just title/summary) as markdown / JSON / plain-text
// / llms, on both the platform host and a seller's custom domain. Hostile post
// fields come from permissionless NIP-23 events, so they must be inert (JSON
// serialization + non-HTML content types).

import {
  buildPostMarkdown,
  buildPostJson,
  buildPostText,
  buildPostLlmsTxt,
  type StallPostInput,
  type StallPostDetail,
} from "@/utils/geo/stall-content";

const postDetail = (over: Partial<StallPostDetail> = {}): StallPostDetail => ({
  title: "Why raw milk matters",
  slug: "why-raw-milk-matters",
  summary: "A short note on freshness.",
  image: "https://cdn.example.com/cover.jpg",
  content: "## Freshness\n\nRaw milk is best straight from the farm.",
  publishedAt: 1_700_000_000,
  updatedAt: 1_700_000_500,
  hashtags: ["rawmilk", "farm"],
  ...over,
});

const baseInput = (over: Partial<StallPostInput> = {}): StallPostInput => ({
  shopName: "Green Pastures",
  slug: "green-pastures",
  siteUrl: "https://milk.market/stall/green-pastures",
  isCustomDomain: false,
  post: postDetail(),
  ...over,
});

describe("buildPostMarkdown", () => {
  it("includes the title, summary, and full body", () => {
    const md = buildPostMarkdown(baseInput());
    expect(md).toContain("# Why raw milk matters");
    expect(md).toContain("> A short note on freshness.");
    expect(md).toContain("## Freshness");
    expect(md).toContain("Raw milk is best straight from the farm.");
  });

  it("renders hashtags and the cover image", () => {
    const md = buildPostMarkdown(baseInput());
    expect(md).toContain("#rawmilk #farm");
    expect(md).toContain(
      "![Why raw milk matters](https://cdn.example.com/cover.jpg)"
    );
  });

  it("links back to the post on the platform host", () => {
    const md = buildPostMarkdown(baseInput());
    expect(md).toContain(
      "Post: https://milk.market/stall/green-pastures/blog/why-raw-milk-matters"
    );
  });

  it("uses the seller's own origin on a custom domain", () => {
    const md = buildPostMarkdown(
      baseInput({
        isCustomDomain: true,
        siteUrl: "https://greenpastures.farm",
      })
    );
    expect(md).toContain(
      "Post: https://greenpastures.farm/blog/why-raw-milk-matters"
    );
  });

  it("renders the external link-out when present", () => {
    const md = buildPostMarkdown(
      baseInput({
        post: postDetail({ externalUrl: "https://example.com/article" }),
      })
    );
    expect(md).toContain("[Read more](https://example.com/article)");
  });

  it("falls back to placeholder text for an empty body", () => {
    const md = buildPostMarkdown(
      baseInput({ post: postDetail({ content: "" }) })
    );
    expect(md).toContain("_This post has no content._");
  });
});

describe("buildPostJson", () => {
  it("returns the full post including the body", () => {
    const json = buildPostJson(baseInput()) as Record<string, unknown>;
    expect(json.type).toBe("article");
    expect(json.url).toBe(
      "https://milk.market/stall/green-pastures/blog/why-raw-milk-matters"
    );
    expect(json.post).toEqual({
      title: "Why raw milk matters",
      slug: "why-raw-milk-matters",
      summary: "A short note on freshness.",
      image: "https://cdn.example.com/cover.jpg",
      content: "## Freshness\n\nRaw milk is best straight from the farm.",
      publishedAt: 1_700_000_000,
      updatedAt: 1_700_000_500,
      hashtags: ["rawmilk", "farm"],
    });
  });

  it("carries a hostile title as inert JSON data (no HTML execution path)", () => {
    const json = buildPostJson(
      baseInput({
        post: postDetail({ title: "<script>alert(1)</script>" }),
      })
    );
    // The hostile value survives as a plain JSON string field — it is data, not
    // executable markup. The endpoint serves this as application/json (never
    // text/html), so the angle brackets can never run as a script.
    const serialized = JSON.stringify(json);
    const roundTripped = JSON.parse(serialized) as {
      post: { title: string };
    };
    expect(roundTripped.post.title).toBe("<script>alert(1)</script>");
    // Quotes inside a hostile value are JSON-escaped so they can't break out of
    // the string and inject new structure.
    const breakout = buildPostJson(
      baseInput({ post: postDetail({ title: 'a","x":"y' }) })
    );
    expect(
      (JSON.parse(JSON.stringify(breakout)) as { post: { title: string } }).post
        .title
    ).toBe('a","x":"y');
  });
});

describe("buildPostText", () => {
  it("strips markdown syntax but keeps the body text", () => {
    const txt = buildPostText(baseInput());
    expect(txt).toContain("Why raw milk matters");
    expect(txt).toContain("Raw milk is best straight from the farm.");
    expect(txt).not.toContain("# Why raw milk matters");
  });
});

describe("buildPostLlmsTxt", () => {
  it("includes an Article section with the full body and AI-agent links", () => {
    const txt = buildPostLlmsTxt(baseInput());
    expect(txt).toContain("# Why raw milk matters");
    expect(txt).toContain("## Article");
    expect(txt).toContain("Raw milk is best straight from the farm.");
    expect(txt).toContain("## For AI Agents");
    expect(txt).toContain("https://milk.market/.well-known/l402.json");
  });
});
