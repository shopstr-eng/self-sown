/** @jest-environment node */

jest.mock(
  "expo-crypto",
  () => ({
    CryptoDigestAlgorithm: { SHA256: "SHA-256" },
    digestStringAsync: jest.fn(async () => "a".repeat(64)),
  }),
  { virtual: true }
);
jest.mock(
  "react-native",
  () => ({ Platform: { OS: "web" } }),
  { virtual: true }
);

import type { BlogPost } from "@self-sown/domain";

import {
  blogDraftFromPost,
  parseHashtags,
  validateBlogEditorDraft,
  validateScheduleDate,
  type BlogEditorDraft,
} from "@/apps/mobile/lib/blog";
import {
  FLOW_TYPE_LABELS,
  FLOW_TYPES,
  formatDelayHours,
} from "@/apps/mobile/lib/email-flows";
import { toBase64 } from "@/apps/mobile/lib/nip98";

const baseDraft: BlogEditorDraft = {
  dTag: "post-1",
  title: "  Hello world  ",
  summary: "  A teaser  ",
  imageUrl: "",
  externalUrl: "",
  hashtags: ["farm"],
  content: "  Body text  ",
};

describe("validateBlogEditorDraft", () => {
  it("trims fields and keeps optional values when present", () => {
    const validated = validateBlogEditorDraft({
      ...baseDraft,
      imageUrl: "https://example.com/a.png",
      externalUrl: "https://example.com/read-more",
    });
    expect(validated).toEqual({
      dTag: "post-1",
      title: "Hello world",
      content: "Body text",
      summary: "A teaser",
      image: "https://example.com/a.png",
      externalUrl: "https://example.com/read-more",
      hashtags: ["farm"],
    });
  });

  it("requires a title", () => {
    expect(validateBlogEditorDraft({ ...baseDraft, title: "  " })).toBe(
      "Give the post a title."
    );
  });

  it("requires content", () => {
    expect(validateBlogEditorDraft({ ...baseDraft, content: " " })).toBe(
      "Write the post content before saving."
    );
  });

  it("rejects non-http(s) image and link URLs", () => {
    expect(
      validateBlogEditorDraft({ ...baseDraft, imageUrl: "javascript:alert(1)" })
    ).toBe("The image URL must start with http:// or https://.");
    expect(
      validateBlogEditorDraft({ ...baseDraft, externalUrl: "ftp://x" })
    ).toBe("The link URL must start with http:// or https://.");
  });

  it("drops blank optional fields entirely", () => {
    const validated = validateBlogEditorDraft({
      ...baseDraft,
      summary: "   ",
    });
    expect(validated).not.toBeInstanceOf(String);
    if (typeof validated === "string") return;
    expect("summary" in validated).toBe(false);
    expect("image" in validated).toBe(false);
    expect("externalUrl" in validated).toBe(false);
  });
});

describe("validateScheduleDate", () => {
  it("rejects an invalid date", () => {
    expect(validateScheduleDate(new Date("not a date"))).toBe(
      "Pick a date and time to schedule this post."
    );
  });

  it("rejects times in the past or under the 60s lead", () => {
    expect(validateScheduleDate(new Date(2000, 0, 1))).toBe(
      "Pick a schedule time at least a minute in the future."
    );
  });

  it("returns epoch seconds for a valid future time", () => {
    const future = new Date(Date.now() + 3_600_000);
    const validated = validateScheduleDate(future);
    expect(typeof validated).toBe("number");
    if (typeof validated === "number") {
      expect(Math.abs(validated * 1000 - future.getTime())).toBeLessThan(
        60_000
      );
    }
  });
});

describe("blogDraftFromPost", () => {
  it("round-trips a published post into editor shape", () => {
    const post: BlogPost = {
      id: "e".repeat(64),
      pubkey: "f".repeat(64),
      dTag: "abc",
      title: "T",
      content: "C",
      publishedAt: 1_700_000_000,
      updatedAt: 1_700_000_000,
      summary: "S",
      image: "https://example.com/i.png",
      externalUrl: "https://example.com/x",
      hashtags: ["a", "b"],
    };
    expect(blogDraftFromPost(post)).toEqual({
      dTag: "abc",
      title: "T",
      summary: "S",
      imageUrl: "https://example.com/i.png",
      externalUrl: "https://example.com/x",
      hashtags: ["a", "b"],
      content: "C",
    });
  });
});

describe("parseHashtags", () => {
  it("splits on commas and whitespace and drops empties", () => {
    expect(parseHashtags("farm, eggs  seasonal,, ")).toEqual([
      "farm",
      "eggs",
      "seasonal",
    ]);
    expect(parseHashtags("")).toEqual([]);
  });
});

describe("email-flows helpers", () => {
  it("covers every flow type with a label", () => {
    for (const type of FLOW_TYPES) {
      expect(FLOW_TYPE_LABELS[type]).toBeTruthy();
    }
  });

  it("formats delay hours like the web dashboard", () => {
    expect(formatDelayHours(0)).toBe("Immediately");
    expect(formatDelayHours(1)).toBe("1 hour after");
    expect(formatDelayHours(5)).toBe("5 hours after");
    expect(formatDelayHours(24)).toBe("1 day after");
    expect(formatDelayHours(72)).toBe("3 days after");
    expect(formatDelayHours(25)).toBe("1d 1h after");
  });
});

describe("toBase64", () => {
  it("encodes ASCII and UTF-8 like btoa(encodeURI) semantics", () => {
    expect(toBase64("hello")).toBe("aGVsbG8=");
    expect(toBase64("héllo → ✓")).toBe(
      Buffer.from("héllo → ✓", "utf8").toString("base64")
    );
    expect(toBase64("")).toBe("");
  });
});
