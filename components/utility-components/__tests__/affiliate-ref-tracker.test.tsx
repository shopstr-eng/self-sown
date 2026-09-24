/** @jest-environment jsdom */

// Coexistence coverage for the cookie/session rename (mm_aff_ref → ss_aff_ref,
// mm_aff_clicks_recorded → ss_aff_clicks_recorded): both generations must be
// read as a UNION during mixed-version rollout, new values win conflicts, and
// the next write persists the merged state under the new name.

import {
  getAffiliateRefCookie,
  bindAffiliateRefToSeller,
} from "../affiliate-ref-tracker";

const SELLER_A = "a".repeat(64);
const SELLER_B = "b".repeat(64);

function setCookie(name: string, value: unknown) {
  document.cookie = `${name}=${encodeURIComponent(JSON.stringify(value))}`;
}

function readCookieJson(name: string): Record<string, string> | null {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  if (!m) return null;
  return JSON.parse(decodeURIComponent(m[1]!));
}

beforeEach(() => {
  for (const name of ["ss_aff_ref", "mm_aff_ref"]) {
    document.cookie = `${name}=; max-age=0; path=/`;
  }
  window.sessionStorage.clear();
  global.fetch = jest.fn().mockResolvedValue({ ok: true }) as jest.Mock;
});

describe("affiliate ref cookie rename coexistence", () => {
  it("reads a referral stored only under the legacy cookie name", () => {
    setCookie("mm_aff_ref", { "*": "LEGACYCODE" });
    expect(getAffiliateRefCookie()).toBe("LEGACYCODE");
  });

  it("unions both cookie generations (per-seller bindings from each survive)", () => {
    setCookie("mm_aff_ref", { [SELLER_A]: "OLDA" });
    setCookie("ss_aff_ref", { [SELLER_B]: "NEWB" });
    expect(getAffiliateRefCookie(SELLER_A)).toBe("OLDA");
    expect(getAffiliateRefCookie(SELLER_B)).toBe("NEWB");
  });

  it("prefers the new cookie's value when both bind the same seller", () => {
    setCookie("mm_aff_ref", { [SELLER_A]: "OLDA" });
    setCookie("ss_aff_ref", { [SELLER_A]: "NEWA" });
    expect(getAffiliateRefCookie(SELLER_A)).toBe("NEWA");
  });

  it("persists the merged map under the new name on the next write", () => {
    setCookie("mm_aff_ref", { "*": "WILD" });
    bindAffiliateRefToSeller(SELLER_A);
    const migrated = readCookieJson("ss_aff_ref");
    expect(migrated).toMatchObject({ "*": "WILD", [SELLER_A]: "WILD" });
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/affiliates/record-click",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("treats a legacy session marker as recorded (no duplicate click POST)", () => {
    setCookie("mm_aff_ref", { [SELLER_A]: "CODEA" });
    window.sessionStorage.setItem(
      "mm_aff_clicks_recorded",
      `${SELLER_A}:CODEA`
    );
    bindAffiliateRefToSeller(SELLER_A);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("records the click once across generations and migrates the marker", () => {
    setCookie("ss_aff_ref", { [SELLER_A]: "CODEA" });
    bindAffiliateRefToSeller(SELLER_A);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // Marker written under the NEW session key...
    expect(window.sessionStorage.getItem("ss_aff_clicks_recorded")).toContain(
      `${SELLER_A}:CODEA`
    );
    // ...and a second bind (either generation) does not refire.
    bindAffiliateRefToSeller(SELLER_A);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
