/** @jest-environment node */

jest.mock("@/utils/db/db-service", () => ({
  fetchCachedEvents: jest.fn(),
  getDbPool: jest.fn(() => ({ query: jest.fn() })),
  getStripeConnectAccount: jest.fn(),
}));

import type { NextApiRequest } from "next";
import { deriveBaseUrl } from "@/utils/ucp/seller-host";

describe("deriveBaseUrl", () => {
  const originalBaseUrl = process.env.NEXT_PUBLIC_BASE_URL;

  afterEach(() => {
    if (originalBaseUrl === undefined) {
      delete process.env.NEXT_PUBLIC_BASE_URL;
    } else {
      process.env.NEXT_PUBLIC_BASE_URL = originalBaseUrl;
    }
  });

  it.each([{}, { host: "localhost:5000" }, { host: "127.0.0.1:5000" }])(
    "falls back to the production site URL for local or absent hosts",
    (headers) => {
      delete process.env.NEXT_PUBLIC_BASE_URL;
      const baseUrl = deriveBaseUrl({ headers } as unknown as NextApiRequest);

      expect(baseUrl).toBe("https://self-sown.com");
      expect(baseUrl).not.toMatch(/localhost|127\.0\.0\.1|\[::1\]/);
    }
  );

  it("uses the configured site URL for a local request", () => {
    process.env.NEXT_PUBLIC_BASE_URL = "https://cutover.example";

    expect(
      deriveBaseUrl({
        headers: { host: "localhost:5000" },
      } as unknown as NextApiRequest)
    ).toBe("https://cutover.example");
  });
});
