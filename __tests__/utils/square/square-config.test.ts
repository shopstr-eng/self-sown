/** @jest-environment node */

// Fail-closed coverage for Square configuration detection.
//
// isSquareConfigured() gates EVERY Square surface (OAuth start/callback,
// buyer card charge, catalog import, settings UI). The security-relevant
// requirement is that it must require an explicit, valid SQUARE_ENVIRONMENT in
// addition to the OAuth id/secret — otherwise getSquareEnvironment() silently
// falls back to "sandbox", so a production deploy that set only the id/secret
// would expose Square in sandbox mode instead of being unavailable.

import { isSquareConfigured } from "@/utils/square/square-config";

describe("isSquareConfigured (fail-closed)", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL };
    delete process.env.SQUARE_OAUTH_CLIENT_ID;
    delete process.env.SQUARE_OAUTH_CLIENT_SECRET;
    delete process.env.SQUARE_ENVIRONMENT;
  });

  afterAll(() => {
    process.env = ORIGINAL;
  });

  it("is false when nothing is set", () => {
    expect(isSquareConfigured()).toBe(false);
  });

  it("is false when id+secret are set but SQUARE_ENVIRONMENT is missing", () => {
    process.env.SQUARE_OAUTH_CLIENT_ID = "id";
    process.env.SQUARE_OAUTH_CLIENT_SECRET = "secret";
    expect(isSquareConfigured()).toBe(false);
  });

  it("is false when SQUARE_ENVIRONMENT is an invalid value", () => {
    process.env.SQUARE_OAUTH_CLIENT_ID = "id";
    process.env.SQUARE_OAUTH_CLIENT_SECRET = "secret";
    process.env.SQUARE_ENVIRONMENT = "staging";
    expect(isSquareConfigured()).toBe(false);
  });

  it("is false when only SQUARE_ENVIRONMENT is set (no credentials)", () => {
    process.env.SQUARE_ENVIRONMENT = "production";
    expect(isSquareConfigured()).toBe(false);
  });

  it("is true with id+secret and SQUARE_ENVIRONMENT=sandbox", () => {
    process.env.SQUARE_OAUTH_CLIENT_ID = "id";
    process.env.SQUARE_OAUTH_CLIENT_SECRET = "secret";
    process.env.SQUARE_ENVIRONMENT = "sandbox";
    expect(isSquareConfigured()).toBe(true);
  });

  it("is true with id+secret and SQUARE_ENVIRONMENT=production (trimmed/cased)", () => {
    process.env.SQUARE_OAUTH_CLIENT_ID = "id";
    process.env.SQUARE_OAUTH_CLIENT_SECRET = "secret";
    process.env.SQUARE_ENVIRONMENT = "  Production  ";
    expect(isSquareConfigured()).toBe(true);
  });
});
