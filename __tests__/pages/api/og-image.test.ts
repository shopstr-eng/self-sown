import type { NextApiRequest, NextApiResponse } from "next";
import sharp from "sharp";

const lookupMock = jest.fn();

jest.mock("dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

// The Postgres-backed rate limiter degrades across many handler calls in the
// jsdom test env (its pg pool can't initialize there); mock it like the other
// API route tests do. Limiter behavior itself is covered by its own tests.
jest.mock("@/utils/rate-limit", () => ({
  applyRateLimit: jest.fn(async () => true),
  __resetRateLimitBuckets: jest.fn(),
}));

import handler, { __setBodyReadDeadlineForTests } from "@/pages/api/og-image";
import { __resetRateLimitBuckets } from "@/utils/rate-limit";

function createResponse() {
  return {
    statusCode: 200,
    jsonBody: undefined as unknown,
    sentBody: undefined as unknown,
    redirectTo: undefined as string | undefined,
    headers: {} as Record<string, string | number>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.jsonBody = payload;
      return this;
    },
    send(payload: unknown) {
      this.sentBody = payload;
      return this;
    },
    redirect(code: number, url: string) {
      this.statusCode = code;
      this.redirectTo = url;
      return this;
    },
    setHeader(key: string, value: string | number) {
      this.headers[key] = value;
      return this;
    },
  };
}

function createRequest(query: Record<string, string>): NextApiRequest {
  return {
    method: "GET",
    query,
    headers: {},
    socket: { remoteAddress: "203.0.113.10" },
  } as unknown as NextApiRequest;
}

function streamBody(buf: Buffer, chunkSize = 64 * 1024) {
  return {
    getReader() {
      let offset = 0;
      return {
        async read() {
          if (offset >= buf.length) return { done: true, value: undefined };
          const value = buf.subarray(offset, offset + chunkSize);
          offset += chunkSize;
          return { done: false, value };
        },
        async cancel() {
          offset = buf.length;
        },
      };
    },
  };
}

function imageResponse(buf: Buffer, contentType = "image/png") {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type" ? contentType : null,
    },
    body: streamBody(buf),
  } as unknown as Response;
}

let noisyPng: Buffer;

beforeAll(async () => {
  // Large noisy source so the compressed output is meaningfully smaller.
  noisyPng = await sharp({
    create: {
      width: 2000,
      height: 1000,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: "gaussian", mean: 128, sigma: 40 },
    },
  })
    .png()
    .toBuffer();
});

describe("/api/og-image", () => {
  beforeEach(() => {
    __resetRateLimitBuckets();
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([{ family: 4, address: "93.184.216.34" }]);
    global.fetch = jest.fn();
  });

  it("compresses and right-sizes an uploaded image to a JPEG", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(noisyPng));

    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-a.example/banner.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/jpeg");
    expect(res.headers["Cache-Control"]).toContain("public");
    const out = res.sentBody as Buffer;
    expect(out.length).toBeLessThan(noisyPng.length);
    const meta = await sharp(out).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.width).toBeLessThanOrEqual(1200);
    expect(meta.height).toBeLessThanOrEqual(630);
  });

  it("serves webp when fmt=webp", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(noisyPng));

    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-b.example/banner.png", fmt: "webp" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["Content-Type"]).toBe("image/webp");
  });

  it("serves a cached copy without refetching", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(noisyPng));

    const first = createResponse();
    await handler(
      createRequest({ url: "https://cdn-c.example/banner.png" }),
      first as unknown as NextApiResponse
    );
    expect(first.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const second = createResponse();
    await handler(
      createRequest({ url: "https://cdn-c.example/banner.png" }),
      second as unknown as NextApiResponse
    );
    expect(second.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not redirect crawlers to non-image upstream URLs", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(
      imageResponse(Buffer.from("<html>nope</html>"), "text/html")
    );

    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-d.example/not-an-image" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(502);
    expect(res.redirectTo).toBeUndefined();
  });

  it("rejects a source that declares a body over the size cap", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type"
            ? "image/png"
            : name.toLowerCase() === "content-length"
              ? String(20 * 1024 * 1024)
              : null,
      },
      body: streamBody(Buffer.alloc(1024)),
    });

    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-e.example/huge.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(413);
    expect(res.redirectTo).toBeUndefined();
  });

  it("rejects URLs that resolve to private addresses", async () => {
    lookupMock.mockResolvedValue([{ family: 4, address: "10.0.0.8" }]);
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(noisyPng));

    const res = createResponse();
    await handler(
      createRequest({ url: "https://internal.example/secret.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects missing or non-http URLs", async () => {
    const res = createResponse();
    await handler(
      createRequest({ url: "ftp://cdn.example/x.png" }),
      res as unknown as NextApiResponse
    );
    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("resolves same-origin relative paths against the platform base", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(noisyPng));

    const res = createResponse();
    await handler(
      createRequest({ url: "/milk-market.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(200);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toBe(
      "https://milk.market/milk-market.png"
    );
  });

  it("rejects network-path relative URLs instead of proxying their host", async () => {
    const res = createResponse();
    await handler(
      createRequest({ url: "//internal.example/secret.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects self-referential API paths", async () => {
    const res = createResponse();
    await handler(
      createRequest({ url: "/api/og-image?url=https://cdn.example/image.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(400);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rejects upstream redirects rather than following or exposing them", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 302,
      headers: {
        get: (name: string) =>
          name === "location" ? "http://10.0.0.1/" : null,
      },
      body: streamBody(Buffer.alloc(0)),
    } as unknown as Response);
    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-redirect.example/image.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(502);
    expect(res.redirectTo).toBeUndefined();
    expect((global.fetch as jest.Mock).mock.calls).toHaveLength(1);
  });

  it("redirects when the upstream body stalls mid-stream", async () => {
    __setBodyReadDeadlineForTests(200);
    const partial = noisyPng.subarray(0, 100 * 1024);
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) =>
          name.toLowerCase() === "content-type" ? "image/png" : null,
      },
      body: {
        getReader() {
          let sent = false;
          return {
            read() {
              if (!sent) {
                sent = true;
                return Promise.resolve({ done: false, value: partial });
              }
              // Never resolves — a stalled/trickling upstream.
              return new Promise(() => undefined);
            },
            async cancel() {},
          };
        },
      },
    } as unknown as Response);

    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-f.example/stalled.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(502);
    expect(res.redirectTo).toBeUndefined();
  });

  it("redirects when the streamed body exceeds the cap mid-stream", async () => {
    // No Content-Length declared; the cap is enforced while streaming.
    const big = Buffer.alloc(11 * 1024 * 1024, 7);
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(big));

    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-g.example/too-big.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(413);
    expect(res.redirectTo).toBeUndefined();
  });

  it("shares one upstream fetch across concurrent requests for the same URL", async () => {
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(noisyPng));

    const first = createResponse();
    const second = createResponse();
    await Promise.all([
      handler(
        createRequest({ url: "https://cdn-h.example/dup.png" }),
        first as unknown as NextApiResponse
      ),
      handler(
        createRequest({ url: "https://cdn-h.example/dup.png" }),
        second as unknown as NextApiResponse
      ),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("flattens alpha when emitting JPEG", async () => {
    const rgba = await sharp({
      create: {
        width: 800,
        height: 400,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 0.3 },
      },
    })
      .png()
      .toBuffer();
    (global.fetch as jest.Mock).mockResolvedValue(imageResponse(rgba));

    const res = createResponse();
    await handler(
      createRequest({ url: "https://cdn-i.example/alpha.png" }),
      res as unknown as NextApiResponse
    );

    expect(res.statusCode).toBe(200);
    const meta = await sharp(res.sentBody as Buffer).metadata();
    expect(meta.format).toBe("jpeg");
    expect(meta.hasAlpha).toBe(false);
  });

  afterEach(() => {
    __setBodyReadDeadlineForTests(null);
  });
});
