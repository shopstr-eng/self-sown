/** @jest-environment node */

// redirect_uri pinning for the Google/Apple login start endpoint: the value is
// stored in cookies, echoed to the provider, and replayed at the callback for
// the token-exchange byte-match. It must be https on this origin with the
// fixed callback path, and free of characters that could inject cookie
// attributes into the Set-Cookie header.

import handler from "@/pages/api/auth/oauth-redirect";

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    redirect: jest.fn(),
    setHeader: jest.fn(),
  } as any;
}

const HOST = "self-sown.com";

function makeReq(redirectUri: unknown, provider = "google", host: string = HOST) {
  return {
    query: { provider, redirect_uri: redirectUri },
    headers: { host },
  } as any;
}

describe("oauth-redirect redirect_uri validation", () => {
  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "google-client-id";
    process.env.APPLE_CLIENT_ID = "com.example.selfsown.web";
  });
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.APPLE_CLIENT_ID;
  });

  it("accepts a same-origin https callback URI and redirects to the provider", () => {
    const res = makeRes();
    handler(
      makeReq(`https://${HOST}/api/auth/oauth-callback`),
      res
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("https://accounts.google.com/")
    );
  });

  it("rejects an off-site redirect_uri", () => {
    const res = makeRes();
    handler(makeReq("https://evil.example/api/auth/oauth-callback"), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("rejects a same-host URI with the wrong path", () => {
    const res = makeRes();
    handler(makeReq(`https://${HOST}/api/auth/other`), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects non-https URIs off localhost", () => {
    const res = makeRes();
    handler(makeReq(`http://${HOST}/api/auth/oauth-callback`), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects cookie-attribute injection via semicolons", () => {
    const res = makeRes();
    handler(
      makeReq(`https://${HOST}/api/auth/oauth-callback?x=1; Domain=evil.example`),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects a malformed URI", () => {
    const res = makeRes();
    handler(makeReq("not a url"), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("allows http only on localhost (dev)", () => {
    const res = makeRes();
    handler(
      makeReq(
        "http://localhost:5000/api/auth/oauth-callback",
        "google",
        "localhost:5000"
      ),
      res
    );
    expect(res.redirect).toHaveBeenCalledWith(
      expect.stringContaining("https://accounts.google.com/")
    );
  });

  it("validates before the Apple branch too", () => {
    const res = makeRes();
    handler(
      makeReq("https://evil.example/api/auth/oauth-callback", "apple"),
      res
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
