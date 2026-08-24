/**
 * API versioning contract (documented in openapi.json x-versioning-policy and
 * /developers#versioning): every /api/* response carries an `API-Version`
 * header with the served major version, and agents may pin a version by
 * sending `API-Version: <major>`. An unsupported pin fails closed with a 400
 * and the shared Error body shape rather than silently serving a different
 * contract than the agent asked for.
 */
export const API_VERSION = "2";

export function isApiVersionSupported(
  version: string | null | undefined
): boolean {
  if (!version) return true; // header absent = latest
  return version.trim() === API_VERSION;
}

export function unsupportedApiVersionBody(received: string) {
  return {
    error: `Unsupported API-Version "${received}". This deployment serves major version ${API_VERSION}; omit the header to track the latest version.`,
    code: "unsupported_api_version",
    status: 400,
    supportedVersions: [API_VERSION],
    documentation: {
      openapi: "https://milk.market/openapi.json",
      versioning: "https://milk.market/developers#versioning",
    },
  };
}
