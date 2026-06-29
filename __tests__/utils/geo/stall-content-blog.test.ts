/** @jest-environment node */

// Unit coverage for blog discoverability in the per-stall machine-readable
// builders (utils/geo/stall-content.ts): published NIP-23 posts must appear in
// the stall's sitemap.xml and its RSS feed, on both the platform host and a
// seller's custom domain. The feed/sitemap link to each post's own internal
// /blog/<slug> page; the optional external link-out is never used here.

import {
  buildStallSitemap,
  buildStallRss,
  buildStallMarkdown,
  buildStallJson,
  buildStallLlmsTxt,
  type StallContentInput,
  type StallBlogSummary,
} from "@/utils/geo/stall-content";

const post = (over: Partial<StallBlogSummary> = {}): StallBlogSummary => ({
  title: "Why raw milk matters",
  slug: "why-raw-milk-matters",
  summary: "A short note on freshness.",
  image: "https://cdn.example.com/cover.jpg",
  publishedAt: 1_700_000_000,
  ...over,
});

const baseInput = (
  over: Partial<StallContentInput> = {}
): StallContentInput => ({
  shopName: "Green Pastures",
  about: "Local raw dairy.",
  image: "",
  slug: "green-pastures",
  siteUrl: "https://milk.market/stall/green-pastures",
  isCustomDomain: false,
  products: [],
  blogPosts: [],
  ...over,
});

describe("buildStallSitemap blog URLs", () => {
  it("adds a /blog/<slug> entry per post on the platform host", () => {
    const xml = buildStallSitemap(baseInput({ blogPosts: [post()] }));
    expect(xml).toContain(
      "<loc>https://milk.market/stall/green-pastures/blog/why-raw-milk-matters</loc>"
    );
  });

  it("uses the seller's own origin on a custom domain", () => {
    const xml = buildStallSitemap(
      baseInput({
        isCustomDomain: true,
        siteUrl: "https://greenpastures.farm",
        blogPosts: [post()],
      })
    );
    expect(xml).toContain(
      "<loc>https://greenpastures.farm/blog/why-raw-milk-matters</loc>"
    );
  });

  it("emits no blog entries when there are no posts", () => {
    const xml = buildStallSitemap(baseInput());
    expect(xml).not.toContain("/blog/");
  });
});

describe("buildStallRss blog items", () => {
  it("lists posts as dated items linking to the internal blog page", () => {
    const rss = buildStallRss(baseInput({ blogPosts: [post()] }));
    expect(rss).toContain("<title>Why raw milk matters</title>");
    expect(rss).toContain(
      "<link>https://milk.market/stall/green-pastures/blog/why-raw-milk-matters</link>"
    );
    expect(rss).toContain(
      `<pubDate>${new Date(1_700_000_000 * 1000).toUTCString()}</pubDate>`
    );
    expect(rss).toContain(
      '<enclosure url="https://cdn.example.com/cover.jpg" type="image/jpeg" />'
    );
  });

  it("escapes hostile post titles (permissionless events)", () => {
    const rss = buildStallRss(
      baseInput({
        blogPosts: [post({ title: "<script>alert(1)</script>" })],
      })
    );
    expect(rss).not.toContain("<script>alert(1)</script>");
    expect(rss).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("renders both blog posts and products in one feed", () => {
    const rss = buildStallRss(
      baseInput({
        blogPosts: [post({ title: "Post A", slug: "post-a" })],
        products: [
          {
            title: "Raw milk gallon",
            slug: "raw-milk-gallon",
            price: 12,
            currency: "USD",
            summary: "Fresh.",
            image: "",
          },
        ],
      })
    );
    expect(rss).toContain("<title>Post A</title>");
    expect(rss).toContain("<title>Raw milk gallon (12 USD)</title>");
  });
});

describe("buildStallMarkdown blog section", () => {
  it("adds a Blog section linking to the internal post page", () => {
    const md = buildStallMarkdown(baseInput({ blogPosts: [post()] }));
    expect(md).toContain("## Blog");
    expect(md).toContain(
      "- [Why raw milk matters](https://milk.market/stall/green-pastures/blog/why-raw-milk-matters) · A short note on freshness."
    );
  });

  it("uses the seller's own origin on a custom domain", () => {
    const md = buildStallMarkdown(
      baseInput({
        isCustomDomain: true,
        siteUrl: "https://greenpastures.farm",
        blogPosts: [post()],
      })
    );
    expect(md).toContain(
      "(https://greenpastures.farm/blog/why-raw-milk-matters)"
    );
  });

  it("omits the Blog section when there are no posts", () => {
    const md = buildStallMarkdown(baseInput());
    expect(md).not.toContain("## Blog");
  });
});

describe("buildStallJson posts", () => {
  it("includes a posts array with the internal URL", () => {
    const json = buildStallJson(baseInput({ blogPosts: [post()] }));
    expect(json.posts).toEqual([
      {
        title: "Why raw milk matters",
        url: "https://milk.market/stall/green-pastures/blog/why-raw-milk-matters",
        summary: "A short note on freshness.",
        image: "https://cdn.example.com/cover.jpg",
        publishedAt: 1_700_000_000,
      },
    ]);
  });

  it("returns an empty posts array when there are no posts", () => {
    const json = buildStallJson(baseInput());
    expect(json.posts).toEqual([]);
  });
});

describe("buildStallLlmsTxt posts section", () => {
  it("adds a Posts section linking to the internal post page", () => {
    const txt = buildStallLlmsTxt(baseInput({ blogPosts: [post()] }));
    expect(txt).toContain("## Posts");
    expect(txt).toContain(
      "- [Why raw milk matters](https://milk.market/stall/green-pastures/blog/why-raw-milk-matters): A short note on freshness."
    );
  });

  it("omits the Posts section when there are no posts", () => {
    const txt = buildStallLlmsTxt(baseInput());
    expect(txt).not.toContain("## Posts");
  });
});
