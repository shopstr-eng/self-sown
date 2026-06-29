import {
  BLOG_POST_KIND,
  buildBlogPostTags,
  parseBlogPostEvent,
  dedupeLatestBlogPosts,
  isHttpUrl,
  normalizeHashtag,
  type BlogPost,
} from "../index";

const findTag = (tags: string[][], name: string) =>
  tags.find((t) => t[0] === name);
const findAll = (tags: string[][], name: string) =>
  tags.filter((t) => t[0] === name);

describe("blog domain helpers", () => {
  describe("buildBlogPostTags", () => {
    test("throws when the d tag is missing", () => {
      expect(() =>
        buildBlogPostTags({ dTag: "  ", title: "Hi", content: "x" }, 100)
      ).toThrow(/identifier/i);
    });

    test("throws when the title is missing", () => {
      expect(() =>
        buildBlogPostTags({ dTag: "abc", title: "   ", content: "x" }, 100)
      ).toThrow(/title/i);
    });

    test("includes d/title/published_at, defaulting published_at to createdAt", () => {
      const tags = buildBlogPostTags(
        { dTag: "post-1", title: "Hello", content: "body" },
        1700
      );
      expect(findTag(tags, "d")).toEqual(["d", "post-1"]);
      expect(findTag(tags, "title")).toEqual(["title", "Hello"]);
      expect(findTag(tags, "published_at")).toEqual(["published_at", "1700"]);
    });

    test("uses an explicit publishedAt (floored)", () => {
      const tags = buildBlogPostTags(
        { dTag: "p", title: "T", content: "b", publishedAt: 1234.9 },
        9999
      );
      expect(findTag(tags, "published_at")).toEqual(["published_at", "1234"]);
    });

    test("only keeps an http(s) image and link-out, dropping hostile schemes", () => {
      const good = buildBlogPostTags(
        {
          dTag: "p",
          title: "T",
          content: "b",
          image: "https://cdn.example/i.png",
          externalUrl: "https://example.com/read",
        },
        1
      );
      expect(findTag(good, "image")).toEqual([
        "image",
        "https://cdn.example/i.png",
      ]);
      expect(findTag(good, "r")).toEqual(["r", "https://example.com/read"]);

      const bad = buildBlogPostTags(
        {
          dTag: "p",
          title: "T",
          content: "b",
          image: "javascript:alert(1)",
          externalUrl: "ftp://example.com",
        },
        1
      );
      expect(findTag(bad, "image")).toBeUndefined();
      expect(findTag(bad, "r")).toBeUndefined();
    });

    test("normalizes and de-duplicates hashtags", () => {
      const tags = buildBlogPostTags(
        {
          dTag: "p",
          title: "T",
          content: "b",
          hashtags: ["#Raw Milk", "raw-milk", "  ", "Farm News"],
        },
        1
      );
      const tTags = findAll(tags, "t").map((t) => t[1]);
      expect(tTags).toEqual(["raw-milk", "farm-news"]);
    });
  });

  describe("parseBlogPostEvent", () => {
    const baseEvent = (overrides: Record<string, unknown> = {}) => ({
      id: "evt-id",
      pubkey: "seller-pubkey",
      kind: BLOG_POST_KIND,
      created_at: 1000,
      content: "markdown body",
      tags: [
        ["d", "post-1"],
        ["title", "Hello"],
        ["published_at", "900"],
      ],
      ...overrides,
    });

    test("returns null for the wrong kind", () => {
      expect(parseBlogPostEvent(baseEvent({ kind: 1 }) as any)).toBeNull();
    });

    test("returns null when d or title is missing", () => {
      expect(
        parseBlogPostEvent(baseEvent({ tags: [["title", "Hi"]] }) as any)
      ).toBeNull();
      expect(
        parseBlogPostEvent(baseEvent({ tags: [["d", "x"]] }) as any)
      ).toBeNull();
    });

    test("parses a full event and reads published_at from the tag", () => {
      const post = parseBlogPostEvent(baseEvent() as any);
      expect(post).toMatchObject({
        id: "evt-id",
        pubkey: "seller-pubkey",
        dTag: "post-1",
        title: "Hello",
        content: "markdown body",
        publishedAt: 900,
        updatedAt: 1000,
      });
    });

    test("falls back to created_at when published_at is absent or non-numeric", () => {
      const post = parseBlogPostEvent(
        baseEvent({
          tags: [
            ["d", "p"],
            ["title", "T"],
            ["published_at", "not-a-number"],
          ],
        }) as any
      );
      expect(post?.publishedAt).toBe(1000);
    });

    test("drops a hostile image scheme but keeps the content", () => {
      const post = parseBlogPostEvent(
        baseEvent({
          tags: [
            ["d", "p"],
            ["title", "T"],
            ["image", "javascript:alert(1)"],
          ],
        }) as any
      );
      expect(post?.image).toBeUndefined();
      expect(post?.content).toBe("markdown body");
    });

    test("selects the first valid http(s) r tag, skipping hostile ones", () => {
      const post = parseBlogPostEvent(
        baseEvent({
          tags: [
            ["d", "p"],
            ["title", "T"],
            ["r", "javascript:alert(1)"],
            ["r", "https://example.com/ok"],
          ],
        }) as any
      );
      expect(post?.externalUrl).toBe("https://example.com/ok");
    });
  });

  describe("dedupeLatestBlogPosts (NIP-23 replacement)", () => {
    const post = (over: Partial<BlogPost>): BlogPost => ({
      id: "id",
      pubkey: "pk",
      dTag: "d",
      title: "t",
      content: "",
      publishedAt: 0,
      updatedAt: 0,
      hashtags: [],
      ...over,
    });

    test("collapses versions of the same post to the newest updatedAt", () => {
      const result = dedupeLatestBlogPosts([
        post({ id: "old", dTag: "a", updatedAt: 10, publishedAt: 10 }),
        post({ id: "new", dTag: "a", updatedAt: 20, publishedAt: 20 }),
      ]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("new");
    });

    test("keeps distinct d tags and sorts newest-first by publishedAt", () => {
      const result = dedupeLatestBlogPosts([
        post({ id: "x", dTag: "a", updatedAt: 5, publishedAt: 5 }),
        post({ id: "y", dTag: "b", updatedAt: 30, publishedAt: 30 }),
      ]);
      expect(result.map((p) => p.id)).toEqual(["y", "x"]);
    });

    test("treats the same d tag from different pubkeys as separate posts", () => {
      const result = dedupeLatestBlogPosts([
        post({ id: "x", pubkey: "pk1", dTag: "a", updatedAt: 5 }),
        post({ id: "y", pubkey: "pk2", dTag: "a", updatedAt: 6 }),
      ]);
      expect(result).toHaveLength(2);
    });
  });

  describe("isHttpUrl", () => {
    test("accepts http and https", () => {
      expect(isHttpUrl("http://a.com")).toBe(true);
      expect(isHttpUrl("https://a.com/x")).toBe(true);
    });
    test("rejects other schemes, empty, and non-strings", () => {
      expect(isHttpUrl("javascript:alert(1)")).toBe(false);
      expect(isHttpUrl("ftp://a.com")).toBe(false);
      expect(isHttpUrl("")).toBe(false);
      expect(isHttpUrl(null)).toBe(false);
      expect(isHttpUrl(42)).toBe(false);
    });
  });

  describe("normalizeHashtag", () => {
    test("strips #, lowercases, and slugifies whitespace", () => {
      expect(normalizeHashtag("#Raw Milk")).toBe("raw-milk");
      expect(normalizeHashtag("  Farm   News  ")).toBe("farm-news");
      expect(normalizeHashtag("###tag")).toBe("tag");
    });
  });
});
