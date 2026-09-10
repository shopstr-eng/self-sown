/** @jest-environment node */

// Domain-cutover continuity: the OAuth token exchange must replay the
// authorize-time redirect URI pinned in the OAuth state row — not one
// reconstructed from the current base URL, which flips when
// NEXT_PUBLIC_BASE_URL changes domains mid-flow.

import { exchangeSquareCodeForToken } from "@/utils/square/square-oauth";
import { exchangeShippoCodeForToken } from "@/utils/shipping/shippo-oauth";

const ENV_KEYS = [
  "SQUARE_OAUTH_CLIENT_ID",
  "SQUARE_OAUTH_CLIENT_SECRET",
  "SHIPPO_OAUTH_CLIENT_ID",
  "SHIPPO_OAUTH_CLIENT_SECRET",
] as const;

describe("OAuth token exchange redirect_uri pinning", () => {
  const fetchSpy = jest.spyOn(global, "fetch");
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      process.env[key] = `test-${key.toLowerCase()}`;
    }
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ access_token: "tok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
  });

  afterEach(() => {
    fetchSpy.mockReset();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("Square replays the pinned authorize-time redirect URI", async () => {
    await exchangeSquareCodeForToken(
      "code123",
      "https://milk.market/square-oauth-redirect"
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.redirect_uri).toBe("https://milk.market/square-oauth-redirect");
  });

  it("Square falls back to the current base URL when nothing was pinned (legacy state row)", async () => {
    const { getSquareRedirectUri } = await import(
      "@/utils/square/square-config"
    );
    await exchangeSquareCodeForToken("code123");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(init.body as string);
    expect(body.redirect_uri).toBe(getSquareRedirectUri());
  });

  it("Shippo replays the pinned authorize-time redirect URI", async () => {
    await exchangeShippoCodeForToken(
      "code123",
      "https://milk.market/shippo-oauth-redirect"
    );
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const params = new URLSearchParams(init.body as string);
    expect(params.get("redirect_uri")).toBe(
      "https://milk.market/shippo-oauth-redirect"
    );
  });

  it("Shippo falls back to the current base URL when nothing was pinned (legacy state row)", async () => {
    const { getShippoRedirectUri } = await import(
      "@/utils/shipping/shippo-oauth"
    );
    await exchangeShippoCodeForToken("code123");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const params = new URLSearchParams(init.body as string);
    expect(params.get("redirect_uri")).toBe(getShippoRedirectUri());
  });
});
