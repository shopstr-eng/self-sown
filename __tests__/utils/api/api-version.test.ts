import {
  API_VERSION,
  isApiVersionSupported,
  unsupportedApiVersionBody,
} from "@/utils/api/api-version";

describe("isApiVersionSupported", () => {
  it("treats an absent header as 'latest'", () => {
    expect(isApiVersionSupported(undefined)).toBe(true);
    expect(isApiVersionSupported(null)).toBe(true);
    expect(isApiVersionSupported("")).toBe(true);
  });

  it("accepts the current major version (whitespace-tolerant)", () => {
    expect(isApiVersionSupported(API_VERSION)).toBe(true);
    expect(isApiVersionSupported(` ${API_VERSION} `)).toBe(true);
  });

  it("rejects other versions", () => {
    expect(isApiVersionSupported("1")).toBe(false);
    expect(isApiVersionSupported("3")).toBe(false);
    expect(isApiVersionSupported("2.1")).toBe(false);
    expect(isApiVersionSupported("abc")).toBe(false);
  });
});

describe("unsupportedApiVersionBody", () => {
  it("uses the shared Error contract with discovery links", () => {
    const body = unsupportedApiVersionBody("1");
    expect(body.code).toBe("unsupported_api_version");
    expect(body.status).toBe(400);
    expect(body.supportedVersions).toEqual([API_VERSION]);
    expect(typeof body.error).toBe("string");
    expect(body.error).toContain('"1"');
    expect(body.documentation.openapi).toContain("openapi.json");
  });
});
