import {
  getSiteUrl,
  getSiteHost,
  SITE_URL,
  SITE_HOST,
  LEGACY_SITE_HOST,
} from "@/utils/site-url";

describe("site-url", () => {
  const ORIGINAL = process.env.NEXT_PUBLIC_BASE_URL;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.NEXT_PUBLIC_BASE_URL;
    else process.env.NEXT_PUBLIC_BASE_URL = ORIGINAL;
  });

  it("falls back to the production domain when the env var is unset", () => {
    delete process.env.NEXT_PUBLIC_BASE_URL;
    expect(getSiteUrl()).toBe("https://self-sown.com");
    expect(getSiteHost()).toBe("self-sown.com");
  });

  it("returns the env var verbatim when set (no normalization)", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://self-sown.com";
    expect(getSiteUrl()).toBe("https://self-sown.com");
    expect(getSiteHost()).toBe("self-sown.com");
    process.env.NEXT_PUBLIC_BASE_URL = "https://milk.market/";
    expect(getSiteUrl()).toBe("https://milk.market/");
  });

  it("treats an empty env var as unset", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "";
    expect(getSiteUrl()).toBe("https://self-sown.com");
  });

  it("pins the legacy (pre-cutover) base domain for proxy redirects", () => {
    expect(LEGACY_SITE_HOST).toBe("milk.market");
  });

  it("derives the host even without a protocol and never throws", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "milk.market";
    expect(getSiteHost()).toBe("milk.market");
  });

  it("module-level constants agree with the getters", () => {
    expect(SITE_URL).toBe(getSiteUrl());
    expect(SITE_HOST).toBe(getSiteHost());
  });
});
